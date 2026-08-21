import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  createSetupMatch,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  type DomainEvent,
  type MatchState,
} from "./index.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `replay-${index + 1}`,
  nickname: `Replay ${index + 1}`,
}));

function apply(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
): { readonly state: MatchState; readonly events: readonly DomainEvent[] } {
  const result = applyCommand(state, {
    origin: "player",
    serverReceivedAt: 0,
    envelope: {
      protocolVersion: 1,
      commandId,
      matchId: state.matchId,
      playerId,
      clientSequence: state.version,
      expectedVersion: state.version,
      clientIssuedAt: 0,
      command,
    },
  });
  if (!result.accepted) throw new Error(`${commandId}: ${result.reason}`);
  return result;
}

function started(seed = "m03-replay-restart-seed"): MatchState {
  let state = createSetupMatch({
    matchId: "m03-replay-match",
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    players: seats,
  });
  for (const playerId of state.turnOrder) {
    state = apply(state, playerId, `choose-${playerId}`, {
      type: "choose-hero",
      heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
    }).state;
  }
  return state;
}

describe("M03 turn event replay", () => {
  it("replays repeated JN10501 private teammate hand transfers across JSON restarts", () => {
    const base = started("jn10501-replay");
    const owner = base.activePlayerId!;
    const ownerTeam = base.players[owner]!.team;
    const teammates = Object.values(base.players)
      .filter((player) => player.id !== owner && player.team === ownerTeam)
      .sort((left, right) => left.seat - right.seat)
      .map((player) => player.id);
    const opponent = Object.values(base.players).find(
      (player) => player.team !== ownerTeam,
    )!.id;
    const claimed = new Set([
      "xyy.card.jp01@1",
      "xyy.card.jp02@2",
      "xyy.card.zp01@16",
      "xyy.card.jp03@3",
    ]);
    const initial: MatchState = {
      ...base,
      players: Object.fromEntries(
        Object.values(base.players).map((player) => [
          player.id,
          {
            ...player,
            heroId: player.id === owner ? "xyy.hero.xj105" : player.heroId,
            hand:
              player.id === owner
                ? ["xyy.card.jp01@1", "xyy.card.jp02@2", "xyy.card.zp01@16"]
                : player.id === opponent
                  ? ["xyy.card.jp03@3"]
                  : [],
            equipment: { weapon: null, armor: null },
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    const firstCommand = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.jp02@2"],
      skillId: "xyy.skill.jn10501",
      targetPlayerIds: [teammates[0]!],
    };
    const first = apply(initial, owner, "jn10501-replay-first", firstCommand);
    const firstAfterRestart = apply(
      JSON.parse(JSON.stringify(initial)) as MatchState,
      owner,
      "jn10501-replay-first",
      firstCommand,
    );
    expect(firstAfterRestart).toEqual(first);

    const secondCommand = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: ["xyy.card.zp01@16"],
      skillId: "xyy.skill.jn10501",
      targetPlayerIds: [teammates[1]!],
    };
    const uninterrupted = apply(
      first.state,
      owner,
      "jn10501-replay-second",
      secondCommand,
    );
    const restarted = apply(
      JSON.parse(JSON.stringify(first.state)) as MatchState,
      owner,
      "jn10501-replay-second",
      secondCommand,
    );
    expect(restarted).toEqual(uninterrupted);

    let replayed = initial;
    for (const domainEvent of [...first.events, ...uninterrupted.events]) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(domainEvent)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.players[owner]!.hand).toEqual([]);
    expect(uninterrupted.state.players[teammates[0]!]!.hand).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.jp02@2",
    ]);
    expect(uninterrupted.state.players[teammates[1]!]!.hand).toEqual([
      "xyy.card.zp01@16",
    ]);
    expect(uninterrupted.state.players[opponent]!.hand).toEqual([
      "xyy.card.jp03@3",
    ]);
    expect(uninterrupted.state.turn?.usedSkillIds).not.toContain(
      "xyy.skill.jn10501",
    );
  });

  it("replays JN40302 collection, private distribution and timeout across JSON restarts", () => {
    const base = started("jn40302-replay");
    const owner = base.activePlayerId!;
    const others = base.turnOrder.filter((playerId) => playerId !== owner);
    const firstTeammate = others[0]!;
    const secondTeammate = others[1]!;
    const opponent = others[2]!;
    const claimed = new Set([
      "xyy.card.jp01@1",
      "xyy.card.jp02@2",
      "xyy.card.zp01@16",
      "xyy.card.jp03@3",
    ]);
    const initial: MatchState = {
      ...base,
      players: Object.fromEntries(
        Object.values(base.players).map((player) => [
          player.id,
          {
            ...player,
            heroId: player.id === owner ? "xyy.hero.x3w03" : player.heroId,
            team:
              player.id === owner ||
              player.id === firstTeammate ||
              player.id === secondTeammate
                ? 1
                : 2,
            hand:
              player.id === owner
                ? ["xyy.card.jp01@1"]
                : player.id === firstTeammate
                  ? ["xyy.card.jp02@2", "xyy.card.zp01@16"]
                  : player.id === secondTeammate
                    ? []
                    : player.id === opponent
                      ? ["xyy.card.jp03@3"]
                      : [],
            equipment: { weapon: null, armor: null },
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    const activationCommand = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: [],
      skillId: "xyy.skill.jn40302",
      targetPlayerIds: [],
    };
    const activation = apply(
      initial,
      owner,
      "jn40302-replay-activate",
      activationCommand,
    );
    const activationAfterRestart = apply(
      JSON.parse(JSON.stringify(initial)) as MatchState,
      owner,
      "jn40302-replay-activate",
      activationCommand,
    );
    expect(activationAfterRestart).toEqual(activation);
    expect(activation.state.players[owner]!.hand).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.jp02@2",
      "xyy.card.zp01@16",
    ]);
    expect(
      createPlayerView(activation.state, owner).pendingChoice,
    ).toMatchObject({
      optionIds: ["xyy.card.jp01@1", "xyy.card.jp02@2", "xyy.card.zp01@16"],
    });
    expect(
      createPlayerView(activation.state, opponent).pendingChoice,
    ).toBeNull();

    const distributionCommand = {
      type: "distribute-brother-hand" as const,
      choiceId: activation.state.pendingChoice!.choiceId,
      cardInstanceIds: ["xyy.card.jp02@2"],
      targetPlayerId: secondTeammate,
    };
    const distributed = apply(
      activation.state,
      owner,
      "jn40302-replay-distribute",
      distributionCommand,
    );
    const distributedAfterRestart = apply(
      JSON.parse(JSON.stringify(activation.state)) as MatchState,
      owner,
      "jn40302-replay-distribute",
      distributionCommand,
    );
    expect(distributedAfterRestart).toEqual(distributed);
    expect(distributed.state.players[secondTeammate]!.hand).toEqual([
      "xyy.card.jp02@2",
    ]);

    const restored = JSON.parse(
      JSON.stringify(distributed.state),
    ) as MatchState;
    const deadline = collectSystemDeadlines(restored).find((candidate) =>
      candidate.targetId.startsWith("choice:"),
    );
    expect(deadline).toBeDefined();
    const timeout = {
      origin: "system-timeout" as const,
      commandId: "jn40302-replay-timeout",
      matchId: restored.matchId,
      expectedVersion: restored.version,
      deadlineAt: deadline!.deadlineAt,
      targetId: deadline!.targetId,
    };
    const uninterrupted = applyCommand(distributed.state, timeout);
    const restarted = applyCommand(restored, timeout);
    expect(restarted).toEqual(uninterrupted);
    expect(uninterrupted.accepted).toBe(true);
    if (!uninterrupted.accepted) throw new Error(uninterrupted.reason);

    let replayed = initial;
    for (const domainEvent of [
      ...activation.events,
      ...distributed.events,
      ...uninterrupted.events,
    ]) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(domainEvent)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.pendingChoice).toBeNull();
    expect(uninterrupted.state.turn?.usedSkillIds).toContain(
      "xyy.skill.jn40302",
    );
    expect(uninterrupted.state.players[owner]!.hand).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.zp01@16",
    ]);
    expect(uninterrupted.state.players[opponent]!.hand).toEqual([
      "xyy.card.jp03@3",
    ]);
  });

  it("replays JN50401 equipment transfer, target memory and draw order across JSON restart", () => {
    const base = started("jn50401-replay");
    const owner = base.activePlayerId!;
    const targets = Object.values(base.players)
      .filter((player) => player.id !== owner)
      .sort((left, right) => left.seat - right.seat)
      .map((player) => player.id);
    const firstTarget = targets[0]!;
    const secondTarget = targets[1]!;
    const claimed = new Set([
      "xyy.card.wq01@47",
      "xyy.card.fj01@52",
      "xyy.card.wq02@48",
    ]);
    const initial: MatchState = {
      ...base,
      players: Object.fromEntries(
        Object.values(base.players).map((player) => [
          player.id,
          {
            ...player,
            heroId: player.id === owner ? "xyy.hero.xj404" : player.heroId,
            handLimit: player.id === owner ? 5 : player.handLimit,
            hand: [],
            equipment:
              player.id === owner
                ? {
                    weapon: "xyy.card.wq01@47",
                    armor: "xyy.card.fj01@52",
                  }
                : player.id === firstTarget
                  ? { weapon: "xyy.card.wq02@48", armor: null }
                  : { weapon: null, armor: null },
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    const firstCommand = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: ["xyy.card.wq01@47"],
      skillId: "xyy.skill.jn50401",
      targetPlayerIds: [firstTarget],
    };
    const first = apply(initial, owner, "jn50401-replay-first", firstCommand);
    const firstAfterRestart = apply(
      JSON.parse(JSON.stringify(initial)) as MatchState,
      owner,
      "jn50401-replay-first",
      firstCommand,
    );
    expect(firstAfterRestart).toEqual(first);
    expect(first.state.turn?.usedSkillTargetIds).toEqual({
      "xyy.skill.jn50401": [firstTarget],
    });

    const repeated = applyCommand(
      JSON.parse(JSON.stringify(first.state)) as MatchState,
      {
        origin: "player",
        serverReceivedAt: 0,
        envelope: {
          protocolVersion: 1,
          commandId: "jn50401-replay-duplicate-target",
          matchId: first.state.matchId,
          playerId: owner,
          clientSequence: first.state.version,
          expectedVersion: first.state.version,
          clientIssuedAt: 0,
          command: {
            type: "activate-hero-skill",
            cardInstanceIds: ["xyy.card.fj01@52"],
            skillId: "xyy.skill.jn50401",
            targetPlayerIds: [firstTarget],
          },
        },
      },
    );
    expect(repeated).toMatchObject({ accepted: false, reason: "forbidden" });

    const secondCommand = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: ["xyy.card.fj01@52"],
      skillId: "xyy.skill.jn50401",
      targetPlayerIds: [secondTarget],
    };
    const uninterrupted = apply(
      first.state,
      owner,
      "jn50401-replay-second",
      secondCommand,
    );
    const resumed = apply(
      JSON.parse(JSON.stringify(first.state)) as MatchState,
      owner,
      "jn50401-replay-second",
      secondCommand,
    );
    expect(resumed).toEqual(uninterrupted);

    let replayed = initial;
    for (const event of [...first.events, ...uninterrupted.events]) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.players[owner]!.hand).toHaveLength(4);
    expect(uninterrupted.state.players[firstTarget]!.equipment.weapon).toBe(
      "xyy.card.wq01@47",
    );
    expect(uninterrupted.state.players[secondTarget]!.equipment.armor).toBe(
      "xyy.card.fj01@52",
    );
    expect(uninterrupted.state.turn?.usedSkillTargetIds).toEqual({
      "xyy.skill.jn50401": [firstTarget, secondTarget],
    });
  });

  it("replays JN50202 draw and seeded mandatory discard across JSON restarts", () => {
    const base = started("jn50202-replay");
    const actor = base.activePlayerId!;
    const originalCard = "xyy.card.jp01@1" as const;
    const initial: MatchState = {
      ...base,
      players: Object.fromEntries(
        Object.values(base.players).map((player) => [
          player.id,
          player.id === actor
            ? {
                ...player,
                heroId: "xyy.hero.xj402",
                hand: [originalCard],
                equipment: { weapon: null, armor: null },
              }
            : { ...player, hand: [], equipment: { weapon: null, armor: null } },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => card !== originalCard),
      discardPile: [],
    };
    const activation = apply(initial, actor, "jn50202-replay-open", {
      type: "activate-hero-skill",
      cardInstanceIds: [],
      skillId: "xyy.skill.jn50202",
      targetPlayerIds: [],
    });
    expect(activation.state.pendingChoice?.optionIds).toEqual([
      originalCard,
      initial.drawPile[0],
    ]);
    const restored = JSON.parse(JSON.stringify(activation.state)) as MatchState;
    const deadline = collectSystemDeadlines(restored).find((candidate) =>
      candidate.targetId.startsWith("choice:"),
    );
    expect(deadline).toBeDefined();
    const timeout = {
      origin: "system-timeout" as const,
      commandId: "jn50202-replay-timeout",
      matchId: restored.matchId,
      expectedVersion: restored.version,
      deadlineAt: deadline!.deadlineAt,
      targetId: deadline!.targetId,
    };
    const uninterrupted = applyCommand(activation.state, timeout);
    const restarted = applyCommand(restored, timeout);
    expect(restarted).toEqual(uninterrupted);
    expect(uninterrupted.accepted).toBe(true);
    if (!uninterrupted.accepted) throw new Error(uninterrupted.reason);

    let replayed = initial;
    for (const event of [...activation.events, ...uninterrupted.events]) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.pendingChoice).toBeNull();
    expect(uninterrupted.state.effectStack).toEqual([]);
    expect(uninterrupted.state.turn?.usedSkillIds).toEqual([
      "xyy.skill.jn50202",
    ]);
    expect(uninterrupted.state.players[actor]!.hand).toHaveLength(1);
    expect(uninterrupted.state.discardPile).toHaveLength(1);
  });

  it("replays JN50201 through its response window and mandatory hidden-card choice", () => {
    const base = started("jn50201-replay");
    const actor = base.activePlayerId!;
    const target = base.turnOrder.find((id) => id !== actor)!;
    const claimed = [
      "xyy.card.zp01@16",
      "xyy.card.jp04@7",
      "xyy.card.fj03@54",
    ] as const;
    const initial: MatchState = {
      ...base,
      players: Object.fromEntries(
        Object.values(base.players).map((player) => [
          player.id,
          player.id === actor
            ? {
                ...player,
                heroId: "xyy.hero.xj402",
                hand: ["xyy.card.zp01@16"],
                equipment: { weapon: null, armor: null },
              }
            : player.id === target
              ? {
                  ...player,
                  hand: ["xyy.card.jp04@7"],
                  equipment: { weapon: null, armor: "xyy.card.fj03@54" },
                }
              : {
                  ...player,
                  hand: [],
                  equipment: { weapon: null, armor: null },
                },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter(
        (card) => !claimed.includes(card as (typeof claimed)[number]),
      ),
      discardPile: [],
    };
    const command = {
      type: "play-skill-converted-card" as const,
      cardInstanceIds: ["xyy.card.zp01@16"],
      skillId: "xyy.skill.jn50201",
      convertedCardId: "xyy.card.jp06",
      targetPlayerIds: [target],
    };
    const startedConversion = apply(initial, actor, "jn50201-replay", command);
    const events: DomainEvent[] = [...startedConversion.events];
    let uninterrupted = startedConversion.state;
    let restarted = JSON.parse(
      JSON.stringify(startedConversion.state),
    ) as MatchState;
    let sequence = 0;
    while (uninterrupted.reactionWindow !== null) {
      const window = uninterrupted.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      const pass = {
        type: "pass-reaction" as const,
        windowId: window.windowId,
      };
      const commandId = `jn50201-replay-pass-${sequence}`;
      const primary = apply(uninterrupted, priority, commandId, pass);
      const recovered = apply(restarted, priority, commandId, pass);
      expect(recovered).toEqual(primary);
      uninterrupted = primary.state;
      restarted = recovered.state;
      events.push(...primary.events);
      sequence += 1;
      if (sequence > 6) throw new Error("JN50201 replay did not converge.");
    }
    expect(uninterrupted.pendingChoice?.optionIds).toEqual([
      "opaque-hand-slot-1",
      "equipment:armor",
    ]);
    const choice = {
      type: "submit-choice" as const,
      choiceId: uninterrupted.pendingChoice!.choiceId,
      selections: ["opaque-hand-slot-1"],
    };
    const primaryChoice = apply(
      uninterrupted,
      actor,
      "jn50201-replay-choice",
      choice,
    );
    const recoveredChoice = apply(
      restarted,
      actor,
      "jn50201-replay-choice",
      choice,
    );
    expect(recoveredChoice).toEqual(primaryChoice);
    events.push(...primaryChoice.events);
    uninterrupted = primaryChoice.state;
    restarted = recoveredChoice.state;
    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(restarted).toEqual(uninterrupted);
    expect(replayed).toEqual(uninterrupted);
    expect(uninterrupted.turn?.usedSkillIds).toEqual(["xyy.skill.jn50201"]);
    expect(uninterrupted.players[target]!.hand).toEqual([]);
    expect(uninterrupted.discardPile).toEqual([
      "xyy.card.zp01@16",
      "xyy.card.jp04@7",
    ]);
  });

  it("replays JN40401 equipment payment before self-healing", () => {
    const base = started("jn40401-replay");
    const actor = base.activePlayerId!;
    const initial: MatchState = {
      ...base,
      players: Object.fromEntries(
        Object.values(base.players).map((player) => [
          player.id,
          player.id === actor
            ? {
                ...player,
                heroId: "xyy.hero.x3w04",
                hp: 1,
                maxHp: 5,
                hand: [],
                equipment: { weapon: null, armor: "xyy.card.fj03@54" },
              }
            : { ...player, hand: [], equipment: { weapon: null, armor: null } },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter(
        (card) => card !== "xyy.card.fj03@54",
      ),
      discardPile: [],
    };
    const command = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: ["xyy.card.fj03@54"],
      skillId: "xyy.skill.jn40401",
      targetPlayerIds: [actor],
    };
    const uninterrupted = apply(initial, actor, "jn40401-replay", command);
    const restarted = apply(
      JSON.parse(JSON.stringify(initial)) as MatchState,
      actor,
      "jn40401-replay",
      command,
    );
    expect(restarted).toEqual(uninterrupted);
    let replayed = initial;
    for (const event of uninterrupted.events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.players[actor]).toMatchObject({
      hp: 3,
      equipment: { weapon: null, armor: null },
    });
    expect(uninterrupted.state.discardPile).toEqual(["xyy.card.fj03@54"]);
  });

  it("replays JN20302 direct healing across a JSON restart", () => {
    const base = started("jn20302-replay");
    const actor = base.activePlayerId!;
    const target = base.turnOrder.find((id) => id !== actor)!;
    const initial: MatchState = {
      ...base,
      players: Object.fromEntries(
        Object.values(base.players).map((player) => [
          player.id,
          player.id === actor
            ? {
                ...player,
                heroId: "xyy.hero.xj203",
                hand: ["xyy.card.jp01@1"],
              }
            : {
                ...player,
                hp: player.id === target ? 1 : player.hp,
                hand: [],
              },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter(
        (card) => card !== "xyy.card.jp01@1",
      ),
      discardPile: [],
    };
    const command = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn20302",
      targetPlayerIds: [target],
    };
    const uninterrupted = apply(initial, actor, "jn20302-replay", command);
    const restarted = apply(
      JSON.parse(JSON.stringify(initial)) as MatchState,
      actor,
      "jn20302-replay",
      command,
    );
    expect(restarted).toEqual(uninterrupted);
    let replayed = initial;
    for (const event of uninterrupted.events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.players[target]!.hp).toBe(3);
    expect(uninterrupted.state.discardPile).toEqual(["xyy.card.jp01@1"]);
  });

  it("replays 剑匣 discard bypass identically across a JSON restart", () => {
    const setupState = started("jn50402-7");
    const ownerId = setupState.activePlayerId!;
    expect(setupState.players[ownerId]).toMatchObject({
      heroId: "xyy.hero.xj404",
      handLimit: 5,
    });
    const extraCard = setupState.drawPile[0]!;
    const initial: MatchState = {
      ...setupState,
      players: {
        ...setupState.players,
        [ownerId]: {
          ...setupState.players[ownerId]!,
          hand: [...setupState.players[ownerId]!.hand, extraCard],
        },
      },
      drawPile: setupState.drawPile.slice(1),
    };
    const command = { type: "end-action" as const };
    const uninterrupted = apply(initial, ownerId, "jn50402-replay", command);
    const restarted = apply(
      JSON.parse(JSON.stringify(initial)) as MatchState,
      ownerId,
      "jn50402-replay",
      command,
    );
    expect(restarted).toEqual(uninterrupted);
    expect(uninterrupted.state.players[ownerId]!.hand).toHaveLength(5);
    expect(uninterrupted.state.turn).toMatchObject({
      number: 2,
      phase: "action",
    });

    let replayed = initial;
    for (const domainEvent of uninterrupted.events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(domainEvent)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
  });

  it("replays WQ04 pawn from an equipped weapon across a JSON restart", () => {
    const startedState = started();
    const actor = startedState.activePlayerId!;
    const initial: MatchState = {
      ...startedState,
      players: {
        ...startedState.players,
        [actor]: {
          ...startedState.players[actor]!,
          hand: [],
          equipment: { weapon: "xyy.card.wq04@50", armor: null },
        },
      },
      drawPile: SETUP_CARD_INSTANCES.filter(
        (card) => card !== "xyy.card.wq04@50",
      ),
      discardPile: [],
    };
    const restarted = JSON.parse(JSON.stringify(initial)) as MatchState;
    const command = {
      type: "play-card" as const,
      cardInstanceId: "xyy.card.wq04@50",
      targetPlayerIds: [],
      mode: "pawn" as const,
    };
    const uninterrupted = apply(initial, actor, "wq04-replay-pawn", command);
    const resumed = apply(restarted, actor, "wq04-replay-pawn", command);
    expect(resumed).toEqual(uninterrupted);
    let replayed = initial;
    for (const event of uninterrupted.events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.players[actor]).toMatchObject({
      hand: expect.any(Array),
      equipment: { weapon: null, armor: null },
    });
    expect(uninterrupted.state.players[actor]!.hand).toHaveLength(2);
    expect(uninterrupted.state.discardPile).toContain("xyy.card.wq04@50");
  });

  it("replays JN10502 through a restarted damage window and delayed reward", () => {
    const base = started("jn10502-replay");
    const actor = base.activePlayerId!;
    const initial: MatchState = {
      ...base,
      players: Object.fromEntries(
        Object.values(base.players).map((player) => [
          player.id,
          {
            ...player,
            heroId: player.id === actor ? "xyy.hero.xj105" : player.heroId,
            hand: [],
            equipment: { weapon: null, armor: null },
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES,
      discardPile: [],
    };
    const hpBefore = Object.fromEntries(
      Object.values(initial.players).map((player) => [player.id, player.hp]),
    );

    const ended = apply(initial, actor, "jn10502-replay-end", {
      type: "end-action",
    });
    expect(ended.state.turn).toMatchObject({
      phase: "reward",
      rewardContinuation: {
        kind: "jn10502-damage",
        step: "resolving-damage",
        pendingTeamDrawPlayerIds: [],
      },
    });
    expect(ended.state.reactionWindow).not.toBeNull();
    expect(
      ended.events.filter(
        (event) =>
          event.type === "turn.cards-drawn" &&
          event.payload.reason === "reward",
      ),
    ).toHaveLength(0);
    let replayed = JSON.parse(JSON.stringify(initial)) as MatchState;
    for (const event of ended.events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(ended.state);

    let state = JSON.parse(JSON.stringify(ended.state)) as MatchState;
    let passIndex = 0;
    while (state.reactionWindow !== null) {
      const before = state;
      const window = state.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      const result = apply(
        state,
        priority,
        `jn10502-replay-pass-${passIndex}`,
        {
          type: "pass-reaction",
          windowId: window.windowId,
        },
      );
      let commandReplay = JSON.parse(JSON.stringify(before)) as MatchState;
      for (const event of result.events) {
        commandReplay = reduceEvent(
          commandReplay,
          JSON.parse(JSON.stringify(event)) as DomainEvent,
        );
      }
      expect(commandReplay).toEqual(result.state);
      state = JSON.parse(JSON.stringify(result.state)) as MatchState;
      passIndex += 1;
    }

    expect(state.turn).toMatchObject({ number: 2, phase: "action" });
    expect(state.players[actor]!.hand).toHaveLength(2);
    for (const player of Object.values(state.players)) {
      expect(player.hp).toBe(
        player.id === actor ? hpBefore[player.id] : hpBefore[player.id]! - 1,
      );
    }
  });

  it("matches uninterrupted execution through JSON restart checkpoints", () => {
    const initial = started();
    let uninterrupted = initial;
    const events: DomainEvent[] = [];
    for (let turn = 0; turn < 200; turn += 1) {
      const actor = uninterrupted.activePlayerId!;
      let result = apply(uninterrupted, actor, `end-${turn}`, {
        type: "end-action",
      });
      uninterrupted = result.state;
      events.push(...result.events);
      if (uninterrupted.turn?.phase === "discard") {
        const action = createPlayerView(uninterrupted, actor)
          .availableActions[0];
        if (action?.type !== "discard-cards")
          throw new Error("missing discard");
        result = apply(uninterrupted, actor, `discard-${turn}`, {
          type: "discard-cards",
          cardInstanceIds: action.cardInstanceIds.slice(0, action.count),
        });
        uninterrupted = result.state;
        events.push(...result.events);
      }
      if (turn % 17 === 0) {
        uninterrupted = JSON.parse(JSON.stringify(uninterrupted)) as MatchState;
      }
    }

    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted);
    expect(replayed.turn).toEqual({
      number: 201,
      phase: "action",
      openedAt: 0,
      deadlineAt: 15_000,
      usedSkillIds: [],
    });
  });
});
