import type { CommandId, PlayerId } from "@xiaoyaoyou/protocol";
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
import { applyReactionCommand, reduceReactionEvent } from "./reaction.js";
import {
  SELECTABLE_HEROES,
  SETUP_CARD_INSTANCES,
  heroDefinition,
  type HeroId,
} from "./setup-content.js";
import { applyTurnCommand, reduceTurnEvent } from "./turn.js";

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

function finalized(state: MatchState): MatchState {
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
    turn: { number: 1, phase: "action" },
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
    next = {
      ...state,
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
    next = finalized(state as MatchState);
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
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
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
      { matchVersion, playerId: envelope.playerId, heroId },
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
