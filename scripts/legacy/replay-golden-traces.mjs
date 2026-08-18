import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const traceRoot = join(workspaceRoot, "oracle", "golden-traces");
const schema = JSON.parse(
  readFileSync(join(traceRoot, "trace.schema.json"), "utf8"),
);
const catalog = JSON.parse(
  readFileSync(join(workspaceRoot, "catalog", "catalog.json"), "utf8"),
);
const knownContentIds = new Set(catalog.items.map((item) => item.canonicalId));
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});
const validate = ajv.compile(schema);

function clone(value) {
  return structuredClone(value);
}

function player(state, id) {
  const found = state.players.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Unknown player ${id}.`);
  return found;
}

function effect(state, id) {
  const found = state.effects.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Unknown effect ${id}.`);
  return found;
}

function requireWindow(state, kind) {
  if (state.window?.kind !== kind)
    throw new Error(`Expected an open ${kind} window.`);
  return state.window;
}

function ensureEligible(window, playerId) {
  if (!window.eligible.includes(playerId)) {
    throw new Error(`Player ${playerId} is not eligible for ${window.kind}.`);
  }
  if (window.passed.includes(playerId)) {
    throw new Error(`Player ${playerId} already passed in ${window.kind}.`);
  }
}

function applyStep(state, step) {
  const params = step.params;
  switch (step.operation) {
    case "set-phase":
      state.phase = params.phase;
      break;
    case "draw":
      player(state, params.player).hand += params.count;
      break;
    case "advance-rounder":
      state.rounder = params.player;
      state.phase = params.phase;
      break;
    case "play-effect":
      if (state.effects.some((candidate) => candidate.id === params.id)) {
        throw new Error(`Duplicate effect ${params.id}.`);
      }
      state.effects.push({
        id: params.id,
        kind: params.kind,
        source: params.source,
        status: "pending",
        targetEffectId: null,
      });
      break;
    case "open-response":
      if (state.window !== null)
        throw new Error("A decision window is already open.");
      if (effect(state, params.effectId).status !== "pending") {
        throw new Error("Only a pending effect can open a response window.");
      }
      state.window = {
        kind: "response",
        subject: params.effectId,
        eligible: params.eligible,
        passed: [],
      };
      break;
    case "pass-response": {
      const window = requireWindow(state, "response");
      ensureEligible(window, params.player);
      window.passed.push(params.player);
      break;
    }
    case "play-counter": {
      const window = requireWindow(state, "response");
      ensureEligible(window, params.source);
      if (window.subject !== params.targetEffectId) {
        throw new Error("Counter target does not match the response subject.");
      }
      const counterSource = player(state, params.source);
      const discard = params.discard ?? 0;
      if (counterSource.hand < discard)
        throw new Error("Counter source lacks the required card.");
      counterSource.hand -= discard;
      state.effects.push({
        id: params.id,
        kind: params.kind,
        source: params.source,
        status: "resolved",
        targetEffectId: params.targetEffectId,
      });
      state.window = null;
      break;
    }
    case "cancel-effect":
      effect(state, params.effectId).status = "cancelled";
      break;
    case "resolve-effect":
      effect(state, params.effectId).status = "resolved";
      state.window = null;
      break;
    case "damage": {
      const target = player(state, params.player);
      if (!target.alive)
        throw new Error("Cannot damage a dead player in a golden trace.");
      target.hp = Math.max(0, target.hp - params.amount);
      break;
    }
    case "detect-dying":
      state.pendingDying = state.players
        .filter((candidate) => candidate.alive && candidate.hp === 0)
        .map((candidate) => candidate.id)
        .sort((left, right) => left - right);
      break;
    case "open-rescue":
      if (!state.pendingDying.includes(params.target)) {
        throw new Error(`Player ${params.target} is not pending dying.`);
      }
      if (state.window !== null)
        throw new Error("A decision window is already open.");
      state.window = {
        kind: "rescue",
        subject: String(params.target),
        eligible: params.eligible,
        passed: [],
      };
      break;
    case "pass-rescue": {
      const window = requireWindow(state, "rescue");
      ensureEligible(window, params.player);
      window.passed.push(params.player);
      break;
    }
    case "rescue": {
      const window = requireWindow(state, "rescue");
      ensureEligible(window, params.source);
      if (window.subject !== String(params.target)) {
        throw new Error("Rescue target does not match the open window.");
      }
      const source = player(state, params.source);
      const target = player(state, params.target);
      if (source.hand < params.discard)
        throw new Error("Rescuer lacks the required card.");
      source.hand -= params.discard;
      target.hp += params.amount;
      state.pendingDying = state.pendingDying.filter(
        (id) => id !== params.target,
      );
      state.window = null;
      break;
    }
    case "close-rescue": {
      const window = requireWindow(state, "rescue");
      if (window.subject !== String(params.target)) {
        throw new Error("Closed rescue target does not match the open window.");
      }
      if (window.eligible.some((id) => !window.passed.includes(id))) {
        throw new Error(
          "A mandatory rescue window cannot close before all eligible players pass.",
        );
      }
      const target = player(state, params.target);
      if (target.hp !== 0)
        throw new Error("A rescued player cannot be marked dead.");
      target.alive = false;
      state.pendingDying = state.pendingDying.filter(
        (id) => id !== params.target,
      );
      state.window = null;
      break;
    }
    case "check-winner": {
      const aliveTeams = [
        ...new Set(
          state.players
            .filter((candidate) => candidate.alive)
            .map((candidate) => candidate.team),
        ),
      ];
      state.winner =
        aliveTeams.length === 1
          ? aliveTeams[0]
          : aliveTeams.length === 0
            ? 0
            : null;
      break;
    }
    default:
      throw new Error(`Unsupported operation ${step.operation}.`);
  }
}

function assertState(state, traceId, stepId) {
  const ids = state.players.map((candidate) => candidate.id);
  if (new Set(ids).size !== 6 || ids.some((id, index) => id !== index + 1)) {
    throw new Error(`${traceId}/${stepId}: players must remain ordered 1..6.`);
  }
  for (const candidate of state.players) {
    if (candidate.hp < 0 || candidate.hand < 0) {
      throw new Error(
        `${traceId}/${stepId}: negative HP/hand invariant failed.`,
      );
    }
  }
  for (const id of state.pendingDying) {
    const candidate = player(state, id);
    if (!candidate.alive || candidate.hp !== 0) {
      throw new Error(`${traceId}/${stepId}: pending-dying invariant failed.`);
    }
  }
}

function sourceHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyOracleSources(trace) {
  const referenceRoot = join(workspaceRoot, "reference", "psd48-master");
  if (!existsSync(referenceRoot)) return;
  for (const source of trace.sources) {
    const relativePath = source.path.replace(/^reference\/psd48-master\//u, "");
    const absolutePath = join(referenceRoot, ...relativePath.split("/"));
    if (!existsSync(absolutePath))
      throw new Error(`${trace.id}: missing source ${source.path}.`);
    if (sourceHash(absolutePath) !== source.sha256) {
      throw new Error(`${trace.id}: source hash drifted for ${source.path}.`);
    }
  }
}

const tracePaths = readdirSync(traceRoot)
  .filter((name) => name.endsWith(".trace.json"))
  .sort()
  .map((name) => join(traceRoot, name));
if (tracePaths.length !== 3)
  throw new Error(
    `Expected exactly 3 golden traces, found ${tracePaths.length}.`,
  );

for (const tracePath of tracePaths) {
  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  if (!validate(trace)) {
    throw new Error(
      `${basename(tracePath)} schema failed:\n${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
  for (const sourceIndex of trace.steps.flatMap((step) => step.evidence)) {
    if (!trace.sources[sourceIndex])
      throw new Error(`${trace.id}: invalid evidence index ${sourceIndex}.`);
  }
  for (const contentId of trace.contentIds) {
    if (!knownContentIds.has(contentId))
      throw new Error(`${trace.id}: unknown content ${contentId}.`);
  }
  verifyOracleSources(trace);
  const state = clone(trace.initialState);
  assertState(state, trace.id, "initial");
  for (const step of trace.steps) {
    applyStep(state, step);
    assertState(state, trace.id, step.id);
  }
  if (JSON.stringify(state) !== JSON.stringify(trace.expectedFinalState)) {
    throw new Error(
      `${trace.id}: replay final state mismatch.\nExpected ${JSON.stringify(trace.expectedFinalState)}\nActual   ${JSON.stringify(state)}`,
    );
  }
  console.log(
    `${trace.id}: ${trace.steps.length} steps replayed (grade ${trace.evidenceGrade}).`,
  );
}
