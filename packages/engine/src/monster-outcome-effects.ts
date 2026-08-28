import type { PlayerId } from "@xiaoyaoyou/protocol";
import type { MatchState } from "./index.js";
import type { MonsterId } from "./encounter-content.js";
import { encounterDefinition } from "./encounter-definitions.js";
import { opposingDecisionPlayerId } from "./encounter.js";
import { planDraw } from "./card-zones.js";
import { planCureBatch, playersAfterCures } from "./healing.js";
import type { AppliedCure } from "./healing.js";
import type { DamageIntent } from "./damage-dying.js";
import { withWeaponSkillEquipment } from "./hero-stats.js";
import type { CardInstanceId } from "./setup-content.js";
import { nextInt } from "./random.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";

type Targets =
  "actor" | "hinder" | "actor-supporter" | "allies" | "enemies" | "living";
type Owner = "actor" | "opponent";
type Step =
  | {
      readonly kind: "harm" | "cure" | "draw";
      readonly targets: Targets;
      readonly amount: number;
    }
  | {
      readonly kind: "choose-harm" | "choose-cure" | "choose-draw";
      readonly targets: Targets;
      readonly amount: number;
      readonly count: number;
      readonly owner: Owner;
    }
  | {
      readonly kind: "steal";
      readonly from: "actor" | "hinder";
      readonly to: "actor" | "hinder";
    }
  | {
      readonly kind:
        | "immobilize"
        | "discard-equipment"
        | "discard-max-equipment"
        | "discard-equipment-draw"
        | "discard-for-cure"
        | "draw-by-equipment"
        | "redraw-allies"
        | "replace-earth";
    };
const harm = (targets: Targets, amount: number): Step => ({
  kind: "harm",
  targets,
  amount,
});
const cure = (targets: Targets, amount: number): Step => ({
  kind: "cure",
  targets,
  amount,
});
const choose = (
  kind: "choose-harm" | "choose-cure" | "choose-draw",
  targets: Targets,
  owner: Owner,
  amount: number,
  count = 1,
): Step => ({ kind, targets, owner, amount, count });

/** FG04 WinEff/LoseEff, explicit empty branches included. Targets are evaluated
 * when their step executes, never frozen before preceding damage/death. */
const PROGRAMS: Readonly<
  Record<string, readonly [readonly Step[], readonly Step[]]>
> = {
  gs01: [[], [{ kind: "immobilize" }]],
  gs02: [
    [harm("enemies", 1), choose("choose-harm", "enemies", "actor", 2)],
    [harm("actor", 2), { kind: "discard-equipment" }],
  ],
  gs03: [[harm("hinder", 4)], [harm("actor", 4)]],
  gs04: [
    [harm("enemies", 1), { kind: "steal", from: "hinder", to: "actor" }],
    [harm("actor", 2), { kind: "steal", from: "actor", to: "hinder" }],
  ],
  gh01: [[harm("hinder", 2)], [harm("actor", 3)]],
  gh02: [[harm("hinder", 3)], [harm("actor", 3)]],
  gh03: [
    [harm("hinder", 3)],
    [choose("choose-harm", "allies", "opponent", 3, 2)],
  ],
  gh04: [[harm("enemies", 2)], [harm("actor-supporter", 2)]],
  gl01: [[choose("choose-cure", "living", "actor", 2)], [harm("actor", 3)]],
  gl02: [
    [choose("choose-draw", "living", "actor", 2)],
    [harm("actor", 2), { kind: "discard-equipment-draw" }],
  ],
  gl03: [
    [{ kind: "discard-for-cure" }],
    [{ kind: "discard-equipment" }, { kind: "discard-max-equipment" }],
  ],
  gl04: [[{ kind: "draw-by-equipment" }], [harm("allies", 2)]],
  gf01: [[{ kind: "draw", targets: "actor", amount: 1 }], [harm("actor", 2)]],
  gf02: [[cure("actor", 2)], [cure("enemies", 2)]],
  gf03: [
    [cure("actor-supporter", 2)],
    [{ kind: "redraw-allies" }, harm("allies", 2)],
  ],
  gf04: [[choose("choose-cure", "enemies", "opponent", 2)], []],
  gt01: [[harm("actor-supporter", 3)], [harm("hinder", 3)]],
  gt02: [[], []],
  gt03: [[harm("enemies", 1)], [harm("allies", 2)]],
  gt04: [[], [{ kind: "replace-earth" }]],
};

export interface MonsterOutcomeChoice {
  readonly choiceId: string;
  readonly playerId: PlayerId;
  readonly targetPlayerId: PlayerId | null;
  readonly optionIds: readonly string[];
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly optional: boolean;
  readonly openedAt: number;
  readonly deadlineAt: number;
  /** Private until all simultaneous choices have been collected. */
  readonly selections: readonly string[] | null;
}
export interface MonsterOutcomeCursor {
  readonly effectId: string;
  readonly monsterId: MonsterId;
  readonly result: "win" | "lose" | "escape";
  readonly stepIndex: number;
  readonly stage: "ready" | "damage" | "choice" | "effects-complete";
  readonly choices: readonly MonsterOutcomeChoice[];
  readonly openedAt: number;
  readonly updatedAt: number;
  /** A GT04 PASSIVE request for the capture adapter, never a fake victory. */
  readonly passiveCapture: {
    readonly ownerPlayerId: PlayerId;
    readonly replacedPetId: MonsterId;
  } | null;
}
export interface MonsterOutcomeTransition {
  readonly state: MatchState;
  readonly cursor: MonsterOutcomeCursor;
  readonly damageIntents: readonly DamageIntent[] | null;
  readonly cures: readonly AppliedCure[];
}
const ordered = (s: MatchState) =>
  Object.values(s.players).sort((a, b) => a.seat - b.seat);
const actorId = (s: MatchState) => s.encounterState.resolution!.activePlayerId;
function targets(s: MatchState, selector: Targets): PlayerId[] {
  const flow = s.encounterState.resolution!;
  const actor = s.players[actorId(s)]!;
  const real = (p: typeof flow.supporter) =>
    p?.kind === "player" ? [p.playerId] : [];
  const ids =
    selector === "actor"
      ? [actor.id]
      : selector === "hinder"
        ? real(flow.hinder)
        : selector === "actor-supporter"
          ? [actor.id, ...real(flow.supporter)]
          : ordered(s)
              .filter(
                (p) =>
                  selector === "living" ||
                  (selector === "allies"
                    ? p.team === actor.team
                    : p.team !== actor.team),
              )
              .map((p) => p.id);
  return [...new Set(ids)].filter((id) => s.players[id]?.alive === true);
}
const equipment = (s: MatchState, id: PlayerId): CardInstanceId[] =>
  Object.values(s.players[id]!.equipment).filter(
    (c): c is CardInstanceId => c !== null,
  );
const allCards = (s: MatchState, id: PlayerId) => [
  ...s.players[id]!.hand,
  ...equipment(s, id),
];
function remove(
  s: MatchState,
  id: PlayerId,
  cards: readonly CardInstanceId[],
): MatchState {
  if (
    new Set(cards).size !== cards.length ||
    cards.some((c) => !allCards(s, id).includes(c))
  )
    throw new Error("Outcome card ownership changed.");
  const player = s.players[id]!;
  const updated = withWeaponSkillEquipment(player, {
    weapon:
      player.equipment.weapon !== null &&
      cards.includes(player.equipment.weapon)
        ? null
        : player.equipment.weapon,
    armor:
      player.equipment.armor !== null && cards.includes(player.equipment.armor)
        ? null
        : player.equipment.armor,
  });
  return {
    ...s,
    players: {
      ...s.players,
      [id]: { ...updated, hand: player.hand.filter((c) => !cards.includes(c)) },
    },
  };
}
function discard(
  s: MatchState,
  id: PlayerId,
  cards: readonly CardInstanceId[],
): MatchState {
  return { ...remove(s, id, cards), discardPile: [...s.discardPile, ...cards] };
}
function draw(s: MatchState, id: PlayerId, count: number): MatchState {
  if (!s.players[id]!.alive || count === 0) return s;
  const plan = planDraw(s, count);
  return {
    ...s,
    drawPile: plan.drawPile,
    discardPile: plan.discardPile,
    rng: plan.rng,
    players: {
      ...s.players,
      [id]: {
        ...s.players[id]!,
        hand: [...s.players[id]!.hand, ...plan.cards],
      },
    },
  };
}
function program(c: MonsterOutcomeCursor): readonly Step[] {
  const table = PROGRAMS[c.monsterId.slice("xyy.monster.".length)];
  if (!table) throw new Error("Unimplemented monster outcome.");
  if (!["win", "lose", "escape"].includes(c.result))
    throw new Error("Invalid monster outcome.");
  return c.result === "escape" ? [] : table[c.result === "win" ? 0 : 1];
}
function quiet(s: MatchState) {
  return (
    !s.reactionWindow &&
    !s.pendingChoice &&
    !s.dyingBatch &&
    s.effectStack.length === 0
  );
}
function validateContext(s: MatchState, c: MonsterOutcomeCursor, at: number) {
  const flow = s.encounterState.resolution;
  if (
    !flow ||
    flow.heldCardId !== c.monsterId ||
    flow.stage !== "monster-effects" ||
    !quiet(s) ||
    !Number.isSafeInteger(at) ||
    at < c.updatedAt ||
    c.updatedAt < c.openedAt ||
    !Number.isSafeInteger(c.stepIndex) ||
    c.stepIndex < 0 ||
    c.stepIndex > program(c).length ||
    c.effectId !==
      `${flow.flowId}:monster:${flow.revealCount}:${c.monsterId}:outcome`
  )
    throw new Error("Invalid monster outcome context.");
}
function choice(
  c: MonsterOutcomeCursor,
  playerId: PlayerId,
  optionIds: readonly string[],
  at: number,
  count = 1,
  optional = false,
  max = count,
  targetPlayerId: PlayerId | null = null,
): MonsterOutcomeChoice {
  return {
    choiceId: `${c.effectId}:${c.stepIndex}:choice:${playerId}`,
    playerId,
    targetPlayerId,
    optionIds: [...optionIds].sort(),
    minSelections: count,
    maxSelections: max,
    optional,
    openedAt: at,
    deadlineAt: at + ACTION_DEADLINE_MS,
    selections: null,
  };
}
function choicesFor(
  s: MatchState,
  c: MonsterOutcomeCursor,
  step: Step,
  at: number,
): MonsterOutcomeChoice[] {
  const actor = actorId(s);
  if (
    step.kind === "choose-harm" ||
    step.kind === "choose-cure" ||
    step.kind === "choose-draw"
  ) {
    const owner =
      step.owner === "actor" ? actor : opposingDecisionPlayerId(s, actor);
    const ids = targets(s, step.targets);
    return owner === null || ids.length === 0
      ? []
      : [choice(c, owner, ids, at, Math.min(step.count, ids.length))];
  }
  if (step.kind === "discard-equipment" || step.kind === "discard-for-cure") {
    const cards =
      step.kind === "discard-equipment"
        ? equipment(s, actor)
        : allCards(s, actor);
    return cards.length === 0
      ? []
      : [
          choice(
            c,
            actor,
            cards,
            at,
            1,
            step.kind === "discard-for-cure",
            step.kind === "discard-for-cure" ? cards.length : 1,
          ),
        ];
  }
  if (step.kind === "discard-max-equipment") {
    const maximum = Math.max(
      ...ordered(s).map((p) => equipment(s, p.id).length),
    );
    return maximum === 0
      ? []
      : ordered(s)
          .filter((p) => equipment(s, p.id).length === maximum)
          .map((p) => choice(c, p.id, equipment(s, p.id), at));
  }
  if (step.kind === "steal") {
    const donor = targets(s, step.from)[0],
      recipient = targets(s, step.to)[0];
    if (!donor || !recipient || donor === recipient) return [];
    const p = s.players[donor]!;
    const options = [
      ...(p.hand.length ? ["hand"] : []),
      ...equipment(s, donor),
    ];
    return options.length
      ? [choice(c, recipient, options, at, 1, false, 1, donor)]
      : [];
  }
  if (step.kind === "replace-earth") {
    const owner = opposingDecisionPlayerId(s, actor);
    const options = ordered(s)
      .filter((p) => p.team !== s.players[actor]!.team)
      .flatMap((p) => s.encounterState.pets[p.id] ?? [])
      .filter((id) => {
        const d = encounterDefinition(id);
        return d.kind === "monster" && d.element === "earth";
      });
    return owner === null || options.length === 0
      ? []
      : [choice(c, owner, options, at, 1, true)];
  }
  return [];
}
function damages(
  c: MonsterOutcomeCursor,
  ids: readonly PlayerId[],
  amount: number,
): DamageIntent[] {
  const def = encounterDefinition(c.monsterId);
  if (def.kind !== "monster") throw new Error("Not a monster.");
  return ids.map((id) => ({
    itemId: `${c.effectId}:${c.stepIndex}:${id}`,
    sourcePlayerId: null,
    sourceMonsterId: c.monsterId,
    targetPlayerId: id,
    amount,
    element: def.element,
    hpEvoMask: ["from-nmb"],
  }));
}
function heal(
  s: MatchState,
  c: MonsterOutcomeCursor,
  ids: readonly PlayerId[],
  amount: number,
) {
  const items = planCureBatch(s, damages(c, ids, amount));
  return { state: { ...s, players: playersAfterCures(s, items) }, items };
}

/** Executes synchronous steps and stops before damage is applied. The runtime
 * adapter must persist this cursor, open the existing damage-response machinery,
 * and resume only when all damage/death descendants are quiet. */
function run(
  input: MatchState,
  initial: MonsterOutcomeCursor,
  at: number,
): MonsterOutcomeTransition {
  let state = input,
    cursor = { ...initial, updatedAt: at };
  const cures: AppliedCure[] = [];
  while (cursor.stepIndex < program(cursor).length) {
    const step = program(cursor)[cursor.stepIndex]!;
    if (step.kind === "harm") {
      const intents = damages(
        cursor,
        targets(state, step.targets),
        step.amount,
      );
      if (intents.length)
        return {
          state,
          cursor: { ...cursor, stage: "damage" },
          damageIntents: intents,
          cures,
        };
    } else if (step.kind === "cure") {
      const result = heal(
        state,
        cursor,
        targets(state, step.targets),
        step.amount,
      );
      state = result.state;
      cures.push(...result.items);
    } else if (step.kind === "draw") {
      for (const id of targets(state, step.targets))
        state = draw(state, id, step.amount);
    } else if (step.kind === "immobilize") {
      const id = actorId(state);
      state = {
        ...state,
        players: {
          ...state.players,
          [id]: { ...state.players[id]!, immobilized: true },
        },
      };
    } else if (step.kind === "discard-equipment-draw") {
      const id = actorId(state),
        cards = equipment(state, id);
      state = draw(discard(state, id, cards), id, cards.length);
    } else if (step.kind === "draw-by-equipment") {
      for (const id of targets(state, "allies"))
        state = draw(state, id, equipment(state, id).length);
    } else if (step.kind === "redraw-allies") {
      const hands = targets(state, "allies").map((id) => ({
        id,
        cards: state.players[id]!.hand,
      }));
      for (const { id, cards } of hands) state = discard(state, id, cards);
      for (const { id, cards } of hands) state = draw(state, id, cards.length);
    } else {
      const choices = choicesFor(state, cursor, step, at);
      if (choices.length)
        return {
          state,
          cursor: { ...cursor, stage: "choice", choices },
          damageIntents: null,
          cures,
        };
    }
    cursor = { ...cursor, stepIndex: cursor.stepIndex + 1 };
  }
  return {
    state,
    cursor: { ...cursor, stage: "effects-complete", choices: [] },
    damageIntents: null,
    cures,
  };
}
export function startMonsterOutcomeEffects(
  state: MatchState,
  result: MonsterOutcomeCursor["result"],
  at: number,
): MonsterOutcomeTransition {
  const flow = state.encounterState.resolution;
  const def = flow?.heldCardId ? encounterDefinition(flow.heldCardId) : null;
  if (!flow || def?.kind !== "monster") throw new Error("No held monster.");
  const cursor: MonsterOutcomeCursor = {
    monsterId: def.id,
    result,
    effectId: `${flow.flowId}:monster:${flow.revealCount}:${def.id}:outcome`,
    stepIndex: 0,
    stage: "ready",
    choices: [],
    openedAt: at,
    updatedAt: at,
    passiveCapture: null,
  };
  validateContext(state, cursor, at);
  return run(state, cursor, at);
}
export function advanceMonsterOutcomeEffects(
  state: MatchState,
  cursor: MonsterOutcomeCursor,
  at: number,
): MonsterOutcomeTransition {
  validateContext(state, cursor, at);
  if (cursor.stage !== "damage")
    throw new Error("Outcome is not awaiting damage completion.");
  return run(
    state,
    { ...cursor, stage: "ready", stepIndex: cursor.stepIndex + 1 },
    at,
  );
}
export function chooseMonsterOutcomeEffect(
  input: MatchState,
  initial: MonsterOutcomeCursor,
  playerId: PlayerId,
  selections: readonly string[] | null,
  at: number,
): MonsterOutcomeTransition {
  validateContext(input, initial, at);
  const own = initial.choices.find(
    (c) => c.playerId === playerId && c.selections === null,
  );
  if (
    initial.stage !== "choice" ||
    !own ||
    at < own.openedAt ||
    (selections !== null && at > own.deadlineAt)
  )
    throw new Error("Invalid monster choice.");
  let state = input,
    selected = selections;
  if (selected === null) {
    if (
      at !==
      (input.connections[playerId]?.status === "auto"
        ? own.openedAt
        : own.deadlineAt)
    )
      throw new Error("Monster choice timeout is not due.");
    selected = [];
    if (!own.optional) {
      const pool = [...own.optionIds].sort();
      const randomSelections: string[] = [];
      for (let i = 0; i < own.minSelections; i++) {
        const next = nextInt(state.rng, pool.length);
        randomSelections.push(pool.splice(next.value, 1)[0]!);
        state = { ...state, rng: next.rng };
      }
      selected = randomSelections;
    }
  }
  if (
    new Set(selected).size !== selected.length ||
    selected.some((x) => !own.optionIds.includes(x)) ||
    selected.length > own.maxSelections ||
    (selected.length < own.minSelections &&
      !(own.optional && selected.length === 0))
  )
    throw new Error("Invalid monster choice options.");
  let cursor: MonsterOutcomeCursor = {
    ...initial,
    updatedAt: at,
    choices: initial.choices.map((c) =>
      c === own ? { ...c, selections: [...selected!].sort() } : c,
    ),
  };
  if (cursor.choices.some((c) => c.selections === null))
    return { state, cursor, damageIntents: null, cures: [] };
  const step = program(cursor)[cursor.stepIndex]!;
  const cures: AppliedCure[] = [];
  for (const c of cursor.choices) {
    const ids = c.selections!;
    if (ids.length === 0) continue;
    if (step.kind === "choose-harm")
      return {
        state,
        cursor: { ...cursor, stage: "damage", choices: [] },
        damageIntents: damages(cursor, ids, step.amount),
        cures,
      };
    if (step.kind === "choose-cure" || step.kind === "discard-for-cure") {
      if (step.kind === "discard-for-cure")
        state = discard(state, c.playerId, ids as CardInstanceId[]);
      const result = heal(
        state,
        cursor,
        step.kind === "choose-cure" ? ids : targets(state, "actor"),
        step.kind === "choose-cure" ? step.amount : ids.length * 2,
      );
      state = result.state;
      cures.push(...result.items);
    } else if (step.kind === "choose-draw") {
      for (const id of ids) state = draw(state, id, step.amount);
    } else if (
      step.kind === "discard-equipment" ||
      step.kind === "discard-max-equipment"
    ) {
      state = discard(state, c.playerId, ids as CardInstanceId[]);
    } else if (step.kind === "steal") {
      const donor = c.targetPlayerId!;
      let card = ids[0] as CardInstanceId;
      if (ids[0] === "hand") {
        const next = nextInt(state.rng, state.players[donor]!.hand.length);
        card = state.players[donor]!.hand[next.value]!;
        state = { ...state, rng: next.rng };
      }
      state = remove(state, donor, [card]);
      state = {
        ...state,
        players: {
          ...state.players,
          [c.playerId]: {
            ...state.players[c.playerId]!,
            hand: [...state.players[c.playerId]!.hand, card],
          },
        },
      };
    } else if (step.kind === "replace-earth" && ids.length) {
      const replacedPetId = ids[0] as MonsterId;
      const owner = ordered(state).find((p) =>
        state.encounterState.pets[p.id]?.includes(replacedPetId),
      );
      if (!owner) throw new Error("GT04 pet ownership changed.");
      cursor = {
        ...cursor,
        passiveCapture: { ownerPlayerId: owner.id, replacedPetId },
      };
    }
  }
  const next = run(
    state,
    { ...cursor, stage: "ready", choices: [], stepIndex: cursor.stepIndex + 1 },
    at,
  );
  return { ...next, cures: [...cures, ...next.cures] };
}
export function projectMonsterOutcomeEffects(
  cursor: MonsterOutcomeCursor,
  viewer: PlayerId,
) {
  const pending = cursor.choices.filter((c) => c.selections === null);
  return {
    monsterId: cursor.monsterId,
    result: cursor.result,
    stage: cursor.stage,
    waitingPlayerIds: pending.map((c) => c.playerId),
    openedAt: pending[0]?.openedAt ?? null,
    deadlineAt: pending[0]?.deadlineAt ?? null,
    availableActions: pending
      .filter((c) => c.playerId === viewer)
      .map((c) => ({
        type: "submit-choice" as const,
        choiceId: c.choiceId,
        optionIds: c.optionIds,
        minSelections: c.minSelections,
        maxSelections: c.maxSelections,
        optional: c.optional,
      })),
  };
}

/** Restore must rederive legal choices from rules and current zones, not trust
 * serialized option lists, owners or selection counts. Collection does not
 * mutate those zones until everyone has answered. */
export function validateMonsterOutcomeCursor(
  s: MatchState,
  c: MonsterOutcomeCursor,
): void {
  const steps = program(c);
  if (
    !Number.isSafeInteger(c.stepIndex) ||
    c.stepIndex < 0 ||
    c.stepIndex > steps.length ||
    !Number.isSafeInteger(c.openedAt) ||
    c.openedAt < 0 ||
    !Number.isSafeInteger(c.updatedAt) ||
    c.updatedAt < c.openedAt ||
    !Array.isArray(c.choices)
  )
    throw new Error("Invalid outcome program cursor.");
  const step = steps[c.stepIndex];
  if (c.stage === "effects-complete") {
    if (step !== undefined || c.choices.length)
      throw new Error("Unfinished outcome effects.");
  } else if (c.stage === "damage") {
    if (
      !step ||
      !["harm", "choose-harm"].includes(step.kind) ||
      c.choices.length
    )
      throw new Error("Invalid outcome damage step.");
  } else if (c.stage === "choice") {
    if (
      !step ||
      !c.choices.length ||
      c.choices.every((x) => x.selections !== null)
    )
      throw new Error("Invalid outcome choice step.");
    const expected = choicesFor(s, c, step, c.choices[0]!.openedAt);
    const actual = c.choices.map((x) => ({ ...x, selections: null }));
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error("Outcome choices disagree with rules.");
    for (const x of c.choices) {
      if (
        !Number.isSafeInteger(x.openedAt) ||
        x.openedAt < c.openedAt ||
        x.openedAt > c.updatedAt
      )
        throw new Error("Invalid outcome choice time.");
      const ids = x.selections;
      if (
        ids !== null &&
        (!Array.isArray(ids) ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => !x.optionIds.includes(id)) ||
          ids.length > x.maxSelections ||
          (ids.length < x.minSelections && !(x.optional && ids.length === 0)))
      )
        throw new Error("Invalid collected outcome response.");
    }
  } else throw new Error("Outcome cursor has no resumable boundary.");
  if (c.passiveCapture !== null) {
    if (
      c.monsterId !== "xyy.monster.gt04" ||
      c.result !== "lose" ||
      c.stage !== "effects-complete" ||
      !s.players[c.passiveCapture.ownerPlayerId]
    )
      throw new Error("Invalid passive capture cursor.");
    const d = encounterDefinition(c.passiveCapture.replacedPetId);
    if (d.kind !== "monster" || d.element !== "earth" || d.id === c.monsterId)
      throw new Error("Invalid replaced earth pet.");
  }
}
