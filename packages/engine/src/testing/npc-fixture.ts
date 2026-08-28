import type { ClientCommand } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  type EngineCommand,
  type MatchState,
  SETUP_CARD_INSTANCES,
  heroDefinition,
} from "../index.js";
import { inspectionFixture } from "./inspection-fixture.js";
import { withPetOwnership } from "../pet-effects.js";
import type { MonsterId } from "../encounter-content.js";
import {
  beginEncounterResolution,
  openNpcDecision,
  chooseNpcAction,
} from "../encounter-resolution.js";
import {
  ENCOUNTER_DEFINITIONS,
  type NpcActionId,
} from "../encounter-definitions.js";

/** Fixture places an already-selected real NPC into the encounter phase. The
 * production end-action gate remains closed until monster effects are complete. */
export function npcFixture(
  actionId: NpcActionId,
  seed = "npc-effects",
  options: { readonly base?: MatchState; readonly at?: number } = {},
): MatchState {
  const base = options.base ?? inspectionFixture(seed);
  const at = options.at ?? 1_000;
  const npc =
    ENCOUNTER_DEFINITIONS.find(
      (d) =>
        d.kind === "npc" &&
        d.actionIds.includes(actionId) &&
        base.encounterDeck.includes(d.id),
    ) ??
    ENCOUNTER_DEFINITIONS.find(
      (d) => d.kind === "npc" && d.actionIds.includes(actionId),
    )!;
  const actor = base.activePlayerId!;
  const swapped = base.encounterDeck.includes(npc.id)
    ? null
    : base.encounterDeck.find((id) => id.startsWith("xyy.npc."))!;
  const cards = [
    npc.id,
    ...base.encounterDeck.filter((id) => id !== npc.id && id !== swapped),
  ];
  const start = beginEncounterResolution(
    `npc:${actionId}`,
    {
      kind: "encounter-decision",
      activePlayerId: actor,
      stage: "ready-reveal",
      outcome: "fight",
      decisionOwnerPlayerId: null,
      supporter: { kind: "player", playerId: actor },
      hinder: null,
      supportOptions: [],
      hinderOptions: [],
      configuredExtraHinderOptions: [],
      revealedCardId: null,
      openedAt: at,
      deadlineAt: at,
    },
    { encounterDeck: cards, encounterDiscard: [], pets: {}, companions: {} },
  );
  const opened = openNpcDecision(start.flow, start.zones, [actionId], at);
  const selected = chooseNpcAction(
    opened.flow,
    opened.zones,
    actor,
    opened.flow.npcDecision!.choiceId,
    actionId,
    at + 1,
  );
  const heroes = [
    "xyy.hero.xj101",
    "xyy.hero.xj102",
    "xyy.hero.xj104",
    "xyy.hero.xj201",
    "xyy.hero.xj401",
    "xyy.hero.xj503",
  ] as const;
  return {
    ...base,
    turn: {
      ...base.turn!,
      phase: "encounter",
      openedAt: at,
      deadlineAt: at,
    },
    encounterDeck: selected.zones.encounterDeck,
    reserveNpcDeck:
      swapped === null
        ? base.reserveNpcDeck
        : base.reserveNpcDeck.map((id) =>
            id === npc.id ? (swapped as typeof id) : id,
          ),
    encounterDiscard: [],
    encounterState: {
      weaponDisabledReasons: {},
      resolution: selected.flow,
      pets: {},
      companions: {},
      npc: null,
    },
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
    players: Object.fromEntries(
      Object.values(base.players).map((p) => {
        const heroId = heroes[p.seat]!;
        const hero = heroDefinition(heroId);
        return [
          p.id,
          {
            ...p,
            heroId,
            hp: hero.maxHp,
            maxHp: hero.maxHp,
            strength: hero.strength,
            dexterity: hero.dexterity,
            hand: [],
            equipment: { weapon: null, armor: null },
          },
        ];
      }),
    ),
    drawPile: SETUP_CARD_INSTANCES,
    discardPile: [],
  };
}
export function npcCommand(
  state: MatchState,
  playerId: string,
  command: ClientCommand,
  now = 2_000,
): EngineCommand {
  return {
    origin: "player",
    serverReceivedAt: now,
    envelope: {
      protocolVersion: 1,
      matchId: state.matchId,
      playerId,
      commandId: `npc-command:${state.version}:${playerId}`,
      clientSequence: state.version,
      expectedVersion: state.version,
      clientIssuedAt: now,
      command,
    },
  };
}

export function grantPets(
  state: MatchState,
  owner: string,
  cards: readonly MonsterId[],
) {
  return withPetOwnership(
    {
      ...state,
      encounterDeck: state.encounterDeck.filter(
        (id) => !cards.includes(id as MonsterId),
      ),
    },
    {
      ...state.encounterState.pets,
      [owner]: [...(state.encounterState.pets[owner] ?? []), ...cards],
    },
  );
}
export function acceptNpcCommand(
  state: MatchState,
  playerId: string,
  selections: readonly string[],
  now = 2_000,
) {
  const result = applyCommand(
    state,
    npcCommand(
      state,
      playerId,
      {
        type: "submit-choice",
        choiceId: state.pendingChoice!.choiceId,
        selections,
      },
      now,
    ),
  );
  if (!result.accepted) throw new Error(`NPC rejected: ${result.reason}`);
  return result;
}
