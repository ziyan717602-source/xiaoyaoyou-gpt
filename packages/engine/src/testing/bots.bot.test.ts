import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  AlwaysPassBot,
  CounterHappyBot,
  FirstLegalBot,
  ProtocolChaosBot,
  RescueBot,
  createSeededRandomBot,
  type BotAction,
  type StrategyBot,
} from "./bots.js";

const actions: readonly BotAction[] = [
  { id: "action:play", kind: "play" },
  { id: "action:pass", kind: "pass" },
  { id: "action:counter", kind: "counter" },
  { id: "action:rescue", kind: "rescue" },
];

describe("six headless strategy bots", () => {
  it("applies each deterministic preference only to server-provided actions", () => {
    expect(FirstLegalBot.choose(actions, { turn: 0, playerId: "p1" }).id).toBe(
      "action:counter",
    );
    expect(
      AlwaysPassBot.choose(actions, { turn: 0, playerId: "p2" }).kind,
    ).toBe("pass");
    expect(
      CounterHappyBot.choose(actions, { turn: 0, playerId: "p3" }).kind,
    ).toBe("counter");
    expect(RescueBot.choose(actions, { turn: 0, playerId: "p4" }).kind).toBe(
      "rescue",
    );
  });

  it("replays a 10,000-turn six-player exploration from its seed", () => {
    function run(seed: number) {
      const bots: StrategyBot[] = [
        FirstLegalBot,
        AlwaysPassBot,
        CounterHappyBot,
        RescueBot,
        createSeededRandomBot(seed),
      ];
      const log: string[] = [];
      for (let turn = 0; turn < 10_000; turn += 1) {
        const playerId = `p${(turn % 6) + 1}`;
        const bot = bots[turn % bots.length]!;
        log.push(
          `${turn}:${playerId}:${bot.choose(actions, { turn, playerId }).id}`,
        );
      }
      return log;
    }
    const seed = 20_260_819;
    const first = run(seed);
    const replay = run(seed);
    try {
      expect(first).toEqual(replay);
    } catch (error) {
      const firstDifference = first.findIndex(
        (entry, index) => entry !== replay[index],
      );
      mkdirSync("artifacts/failures", { recursive: true });
      writeFileSync(
        "artifacts/failures/p07-bot-long-game.json",
        `${JSON.stringify({ seed, initialSnapshot: { turn: 0, players: ["p1", "p2", "p3", "p4", "p5", "p6"], availableActions: actions }, commandLog: first, replayLog: replay, minimizedFailureSequence: first.slice(0, Math.max(1, firstDifference + 1)), error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
      );
      throw error;
    }
  });

  it("cycles duplicate, stale, forbidden, and valid protocol mutations", () => {
    expect(
      Array.from(
        { length: 8 },
        (_, turn) =>
          ProtocolChaosBot.choose(actions, { turn, playerId: "p6" }).mutation,
      ),
    ).toEqual([
      "duplicate",
      "stale-version",
      "forbidden-player",
      "none",
      "duplicate",
      "stale-version",
      "forbidden-player",
      "none",
    ]);
  });
});
