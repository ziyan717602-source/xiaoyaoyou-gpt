import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type CommandEnvelope,
  type CommandId,
  type PlayerId,
} from "@xiaoyaoyou/protocol";
import type {
  ApplyCommandResult,
  DomainEvent,
  EngineCommand,
} from "./architecture.js";
import {
  createInitialMatch,
  type CreateMatchInput,
  type HeroOffer,
  type MatchState,
  type PlayerState,
  type TeamId,
} from "./index.js";
import { seedCommitment, nextInt, shuffle } from "./random.js";
import { applyDyingCommand, reduceDyingEvent } from "./damage-dying.js";
import { applyReactionCommand, reduceReactionEvent } from "./reaction.js";
import {
  SELECTABLE_HEROES,
  SETUP_CARD_INSTANCES,
  heroDefinition,
  type HeroId,
} from "./setup-content.js";
import { applyTurnCommand, reduceTurnEvent } from "./turn.js";
import { applyTurnTimeout } from "./turn.js";
import {
  ACTION_DEADLINE_MS,
  applySystemCommand as applySystemEngineCommand,
  reduceTimeRecoveryEvent,
  type SystemDeadline,
} from "./time-recovery.js";

const PLAYER_COUNT = 6;
const HERO_CHOICES = 3;
const INITIAL_HAND_SIZE = 3;

function event(
  state: MatchState,
  commandId: CommandId,
  offset: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): DomainEvent {
  const sequence = state.eventSequence + offset;
  return {
    eventId: `${state.matchId}:event:${sequence}`,
    sequence,
    matchId: state.matchId,
    causationCommandId: commandId,
    causationEventId:
      offset === 1 ? null : `${state.matchId}:event:${sequence - 1}`,
    rulesetVersion: state.rulesetVersion,
    type,
    payload,
  };
}

function finalized(state: MatchState, startedAt: number): MatchState {
  if (state.setup === null) throw new Error("Setup state is missing.");
  const selected = state.turnOrder.map(
    (playerId) => state.setup!.offers[playerId]?.selectedHeroId,
  );
  if (selected.some((heroId) => heroId === null || heroId === undefined)) {
    throw new Error("Cannot complete setup before all heroes are selected.");
  }
  let drawOffset = 0;
  let players: Record<PlayerId, PlayerState> = { ...state.players };
  for (const playerId of state.turnOrder) {
    const player = players[playerId];
    const heroId = state.setup.offers[playerId]!.selectedHeroId!;
    if (player === undefined) throw new Error(`Unknown player ${playerId}.`);
    const hero = heroDefinition(heroId);
    const hand = state.drawPile.slice(
      drawOffset,
      drawOffset + INITIAL_HAND_SIZE,
    );
    drawOffset += INITIAL_HAND_SIZE;
    players = {
      ...players,
      [playerId]: {
        ...player,
        heroId,
        alive: true,
        hp: hero.maxHp,
        maxHp: hero.maxHp,
        strength: hero.strength,
        dexterity: hero.dexterity,
        hand,
      },
    };
  }
  return {
    ...state,
    phase: "playing",
    activePlayerId: state.turnOrder[0] ?? null,
    turn: {
      number: 1,
      phase: "action",
      openedAt: startedAt,
      deadlineAt: startedAt + ACTION_DEADLINE_MS,
    },
    winner: null,
    players,
    drawPile: state.drawPile.slice(drawOffset),
    setup: { ...state.setup, status: "completed" },
  };
}

export function createSetupMatch(input: CreateMatchInput): MatchState {
  if (input.players.length !== PLAYER_COUNT) {
    throw new Error("M02 setup requires exactly six players.");
  }
  let state = createInitialMatch(input);
  let rng = state.rng;
  const orderedPlayers = Object.values(state.players)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  const shuffledPlayers = shuffle(orderedPlayers, rng);
  rng = shuffledPlayers.rng;
  const turnOrder = shuffledPlayers.values;

  const shuffledHeroes = shuffle(
    SELECTABLE_HEROES.map((hero) => hero.id).sort(),
    rng,
  );
  rng = shuffledHeroes.rng;
  const requiredHeroes = PLAYER_COUNT * (HERO_CHOICES + 1);
  if (shuffledHeroes.values.length < requiredHeroes) {
    throw new Error(`M02 setup requires at least ${requiredHeroes} heroes.`);
  }

  const shuffledCards = shuffle(SETUP_CARD_INSTANCES, rng);
  rng = shuffledCards.rng;
  const offers: Record<PlayerId, HeroOffer> = {};
  for (const [turnIndex, playerId] of turnOrder.entries()) {
    const replacementIndex = nextInt(rng, HERO_CHOICES);
    rng = replacementIndex.rng;
    offers[playerId] = {
      candidateHeroIds: shuffledHeroes.values.slice(
        turnIndex * HERO_CHOICES,
        (turnIndex + 1) * HERO_CHOICES,
      ),
      replacementHeroId:
        shuffledHeroes.values[PLAYER_COUNT * HERO_CHOICES + turnIndex]!,
      replacementIndex: replacementIndex.value,
      rerolled: false,
      selectedHeroId: null,
    };
  }

  const players = Object.fromEntries(
    Object.values(state.players).map((player) => {
      const turnIndex = turnOrder.indexOf(player.id);
      return [
        player.id,
        {
          ...player,
          turnIndex,
          team: (turnIndex % 2 === 0 ? 1 : 2) as TeamId,
        },
      ];
    }),
  );
  state = {
    ...state,
    phase: "setup",
    turnOrder,
    players,
    drawPile: shuffledCards.values,
    setup: {
      status: "selecting-heroes",
      seedCommitment: seedCommitment(input.seed),
      openedAt: input.openedAt ?? 0,
      deadlineAt: (input.openedAt ?? 0) + ACTION_DEADLINE_MS,
      offers,
    },
    rng,
  };
  return state;
}

function numberPayload(event: DomainEvent, key: string): number {
  const value = event.payload[key];
  if (typeof value !== "number") throw new Error(`Invalid ${key} payload.`);
  return value;
}

function stringPayload(event: DomainEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value !== "string") throw new Error(`Invalid ${key} payload.`);
  return value;
}

export function reduceEvent(
  state: Readonly<MatchState>,
  eventToReduce: Readonly<DomainEvent>,
): MatchState {
  if (
    eventToReduce.type.startsWith("connection.") ||
    eventToReduce.type === "system.timeout-resolved"
  ) {
    return reduceTimeRecoveryEvent(state, eventToReduce);
  }
  if (
    eventToReduce.type.startsWith("turn.") ||
    eventToReduce.type === "match.finished"
  ) {
    return reduceTurnEvent(state, eventToReduce);
  }
  if (
    eventToReduce.type.startsWith("reaction.") ||
    eventToReduce.type.startsWith("effect.")
  ) {
    return reduceReactionEvent(state, eventToReduce);
  }
  if (
    eventToReduce.type.startsWith("rescue.") ||
    eventToReduce.type.startsWith("death.")
  ) {
    return reduceDyingEvent(state, eventToReduce);
  }
  if (
    eventToReduce.matchId !== state.matchId ||
    eventToReduce.sequence !== state.eventSequence + 1 ||
    eventToReduce.rulesetVersion !== state.rulesetVersion
  ) {
    throw new Error("Setup event does not extend the current match head.");
  }
  if (state.setup === null) throw new Error("Setup state is missing.");
  const matchVersion = numberPayload(eventToReduce, "matchVersion");
  let next: MatchState;
  if (eventToReduce.type === "setup.hero-rerolled") {
    const playerId = stringPayload(eventToReduce, "playerId");
    const replacementIndex = numberPayload(eventToReduce, "replacementIndex");
    const replacementHeroId = stringPayload(
      eventToReduce,
      "replacementHeroId",
    ) as HeroId;
    const offer = state.setup.offers[playerId];
    if (
      offer === undefined ||
      offer.rerolled ||
      offer.selectedHeroId !== null
    ) {
      throw new Error("Hero reroll event is not applicable.");
    }
    const candidateHeroIds = [...offer.candidateHeroIds];
    candidateHeroIds[replacementIndex] = replacementHeroId;
    next = {
      ...state,
      setup: {
        ...state.setup,
        offers: {
          ...state.setup.offers,
          [playerId]: { ...offer, candidateHeroIds, rerolled: true },
        },
      },
    };
  } else if (eventToReduce.type === "setup.hero-selected") {
    const playerId = stringPayload(eventToReduce, "playerId");
    const heroId = stringPayload(eventToReduce, "heroId") as HeroId;
    const offer = state.setup.offers[playerId];
    const player = state.players[playerId];
    if (
      offer === undefined ||
      player === undefined ||
      offer.selectedHeroId !== null ||
      !offer.candidateHeroIds.includes(heroId)
    ) {
      throw new Error("Hero selection event is not applicable.");
    }
    let rng = state.rng;
    if (eventToReduce.payload.timeout === true) {
      const sortedOptions = [...offer.candidateHeroIds].sort();
      const planned = nextInt(rng, sortedOptions.length);
      const optionSetHash = createHash("sha256")
        .update(JSON.stringify(sortedOptions))
        .digest("hex");
      if (
        sortedOptions[planned.value] !== heroId ||
        eventToReduce.payload.optionSetHash !== optionSetHash ||
        eventToReduce.payload.rngCursorStart !== rng.cursor ||
        eventToReduce.payload.rngCursorEnd !== planned.rng.cursor
      ) {
        throw new Error(
          "Timed-out hero selection disagrees with deterministic RNG.",
        );
      }
      rng = planned.rng;
    }
    next = {
      ...state,
      rng,
      players: { ...state.players, [playerId]: { ...player, heroId } },
      setup: {
        ...state.setup,
        offers: {
          ...state.setup.offers,
          [playerId]: { ...offer, selectedHeroId: heroId },
        },
      },
    };
  } else if (eventToReduce.type === "setup.completed") {
    next = finalized(
      state as MatchState,
      numberPayload(eventToReduce, "startedAt"),
    );
  } else {
    throw new Error(`Unsupported setup event ${eventToReduce.type}.`);
  }
  return {
    ...next,
    version: matchVersion,
    eventSequence: eventToReduce.sequence,
  };
}

export function applyCommand(
  input: Readonly<MatchState>,
  command: Readonly<EngineCommand>,
): ApplyCommandResult {
  if (command.origin !== "player") {
    return applySystemEngineCommand(input, command, resolveTimeout);
  }
  const { envelope, serverReceivedAt } = command;
  if (
    envelope.matchId !== input.matchId ||
    !(envelope.playerId in input.players)
  ) {
    return {
      accepted: false,
      reason: "forbidden",
      currentVersion: input.version,
    };
  }
  if (envelope.expectedVersion !== input.version) {
    return {
      accepted: false,
      reason: "stale-version",
      currentVersion: input.version,
    };
  }
  if (input.phase === "finished") {
    return {
      accepted: false,
      reason: "match-finished",
      currentVersion: input.version,
    };
  }
  if (input.phase === "playing") {
    if (input.dyingBatch !== null) {
      return applyDyingCommand(input, envelope, serverReceivedAt);
    }
    return input.reactionWindow === null
      ? applyTurnCommand(input, envelope, serverReceivedAt)
      : applyReactionCommand(input, envelope, serverReceivedAt);
  }
  if (input.phase !== "setup" || input.setup === null) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  const offer = input.setup.offers[envelope.playerId];
  if (offer === undefined || offer.selectedHeroId !== null) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  if (
    !Number.isSafeInteger(serverReceivedAt) ||
    serverReceivedAt < 0 ||
    serverReceivedAt > input.setup.deadlineAt
  ) {
    return {
      accepted: false,
      reason:
        serverReceivedAt > input.setup.deadlineAt
          ? "expired-window"
          : "invalid",
      currentVersion: input.version,
    };
  }
  const matchVersion = input.version + 1;
  let events: DomainEvent[];
  if (envelope.command.type === "reroll-hero") {
    if (offer.rerolled) {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: input.version,
      };
    }
    events = [
      event(input, envelope.commandId, 1, "setup.hero-rerolled", {
        matchVersion,
        playerId: envelope.playerId,
        replacementIndex: offer.replacementIndex,
        replacementHeroId: offer.replacementHeroId,
      }),
    ];
  } else if (envelope.command.type === "choose-hero") {
    const heroId = envelope.command.heroId as HeroId;
    if (!offer.candidateHeroIds.includes(heroId)) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const selection = event(
      input,
      envelope.commandId,
      1,
      "setup.hero-selected",
      {
        matchVersion,
        playerId: envelope.playerId,
        heroId,
        selectedAt: serverReceivedAt,
      },
    );
    const selected = reduceEvent(input, selection);
    const allSelected = Object.values(selected.setup!.offers).every(
      (candidate) => candidate.selectedHeroId !== null,
    );
    events = allSelected
      ? [
          selection,
          event(input, envelope.commandId, 2, "setup.completed", {
            matchVersion,
            firstPlayerId: input.turnOrder[0],
            startedAt: serverReceivedAt,
          }),
        ]
      : [selection];
  } else {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }

  let state: MatchState = input as MatchState;
  for (const nextEvent of events) state = reduceEvent(state, nextEvent);
  return { accepted: true, state, events };
}

function timeoutEnvelope(
  state: Readonly<MatchState>,
  commandId: CommandId,
  playerId: PlayerId,
  command: ClientCommand,
  deadlineAt: number,
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    matchId: state.matchId,
    playerId,
    clientSequence: 0,
    expectedVersion: state.version,
    clientIssuedAt: deadlineAt,
    command,
  };
}

function resolveSetupTimeout(
  state: Readonly<MatchState>,
  command: Readonly<Extract<EngineCommand, { origin: "system-timeout" }>>,
  deadline: Readonly<SystemDeadline>,
): ApplyCommandResult {
  const offer = state.setup?.offers[deadline.playerId];
  if (
    state.phase !== "setup" ||
    state.setup?.status !== "selecting-heroes" ||
    offer === undefined ||
    offer.selectedHeroId !== null
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: state.version,
    };
  }
  const sortedOptions = [...offer.candidateHeroIds].sort();
  const planned = nextInt(state.rng, sortedOptions.length);
  const heroId = sortedOptions[planned.value]!;
  const matchVersion = state.version + 1;
  const selection = event(
    state as MatchState,
    command.commandId,
    1,
    "setup.hero-selected",
    {
      matchVersion,
      playerId: deadline.playerId,
      heroId,
      selectedAt: command.deadlineAt,
      timeout: true,
      optionSetHash: createHash("sha256")
        .update(JSON.stringify(sortedOptions))
        .digest("hex"),
      rngCursorStart: state.rng.cursor,
      rngCursorEnd: planned.rng.cursor,
    },
  );
  const selected = reduceEvent(state, selection);
  const allSelected = Object.values(selected.setup!.offers).every(
    (candidate) => candidate.selectedHeroId !== null,
  );
  const events = allSelected
    ? [
        selection,
        event(state as MatchState, command.commandId, 2, "setup.completed", {
          matchVersion,
          firstPlayerId: state.turnOrder[0],
          startedAt: command.deadlineAt,
        }),
      ]
    : [selection];
  let next = state as MatchState;
  for (const nextEvent of events) next = reduceEvent(next, nextEvent);
  return { accepted: true, state: next, events };
}

function resolveTimeout(
  state: Readonly<MatchState>,
  command: Readonly<Extract<EngineCommand, { origin: "system-timeout" }>>,
  deadline: Readonly<SystemDeadline>,
): ApplyCommandResult {
  if (deadline.targetId.startsWith("setup:")) {
    return resolveSetupTimeout(state, command, deadline);
  }
  if (deadline.targetId.startsWith("reaction:")) {
    const window = state.reactionWindow;
    if (window === null) {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: state.version,
      };
    }
    return applyReactionCommand(
      state,
      timeoutEnvelope(
        state,
        command.commandId,
        deadline.playerId,
        { type: "pass-reaction", windowId: window.windowId },
        command.deadlineAt,
      ),
      command.deadlineAt,
    );
  }
  if (deadline.targetId.startsWith("rescue:")) {
    const choice = state.pendingChoice;
    if (choice === null) {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: state.version,
      };
    }
    return applyDyingCommand(
      state,
      timeoutEnvelope(
        state,
        command.commandId,
        deadline.playerId,
        { type: "pass-rescue", choiceId: choice.choiceId },
        command.deadlineAt,
      ),
      command.deadlineAt,
    );
  }
  if (deadline.targetId.startsWith("turn:")) {
    return applyTurnTimeout(state, command, deadline.playerId);
  }
  return {
    accepted: false,
    reason: "not-available",
    currentVersion: state.version,
  };
}
