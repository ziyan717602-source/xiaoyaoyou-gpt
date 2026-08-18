import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitialMatch,
  projectPlayerView,
  type MatchState,
} from "@xiaoyaoyou/engine";
import {
  type MatchId,
  type PlayerId,
  validateServerMessage,
} from "@xiaoyaoyou/protocol";
import WebSocket from "ws";
import { buildServer } from "./index.js";
import { SqliteEventStore } from "./persistence.js";

const LOCAL_MATCH_ID = "local-architecture-six";
const LOCAL_RULESET = "standard-fengmingyushi@1";
const localSeats = Array.from({ length: 6 }, (_, index) => ({
  matchId: LOCAL_MATCH_ID,
  playerId: `local-player-${index + 1}`,
  reconnectToken: `local-only-token-${index + 1}-`.padEnd(
    64,
    String(index + 1),
  ),
}));

function makeInitialState(): MatchState {
  const base = createInitialMatch({
    matchId: LOCAL_MATCH_ID,
    rulesetVersion: LOCAL_RULESET,
    seed: "local-architecture-seed-not-for-production",
    players: localSeats.map((seat, index) => ({
      id: seat.playerId,
      nickname: `本地玩家 ${index + 1}`,
    })),
  });
  return {
    ...base,
    players: Object.fromEntries(
      Object.values(base.players).map((player) => [
        player.id,
        { ...player, hand: [`local-private-card-seat-${player.seat + 1}`] },
      ]),
    ),
  };
}

function openLocalClient(
  url: string,
  seat: (typeof localSeats)[number],
): Promise<{ readonly socket: WebSocket; readonly view: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(
      () => reject(new Error("Local client timed out.")),
      5_000,
    );
    let authenticated = false;
    socket.on("message", (raw) => {
      const parsed: unknown = JSON.parse(raw.toString());
      const validation = validateServerMessage(parsed);
      if (!validation.ok || validation.value === undefined) {
        clearTimeout(timer);
        reject(new Error("Server emitted an invalid protocol message."));
        return;
      }
      const message = validation.value;
      if (message.type === "hello") {
        socket.send(
          JSON.stringify({
            type: "authenticate",
            protocolVersion: 1,
            matchId: seat.matchId,
            playerId: seat.playerId,
            reconnectToken: seat.reconnectToken,
            clientInstanceId: `local-bot-${seat.playerId}`,
          }),
        );
      }
      if (message.type === "authenticated") {
        authenticated = true;
      }
      if (message.type === "player-view" && authenticated) {
        clearTimeout(timer);
        resolve({ socket, view: message.view });
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const smoke = process.argv.includes("--smoke");
const port = Number.parseInt(process.env.PORT ?? (smoke ? "0" : "3000"), 10);
const databasePath = smoke
  ? ":memory:"
  : join(process.cwd(), ".local", "xiaoyaoyou.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const store = new SqliteEventStore(databasePath);
let state: MatchState;
try {
  state = store.recover<MatchState>(LOCAL_MATCH_ID).snapshot.state;
} catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith("Unknown match")) {
    throw error;
  }
  state = makeInitialState();
  store.createMatch({
    matchId: LOCAL_MATCH_ID,
    rulesetVersion: LOCAL_RULESET,
    persistenceVersion: state.persistenceVersion,
    state,
    now: Date.now(),
  });
}

const server = await buildServer({
  logger: !smoke,
  exposeMetrics: true,
  staticRoot: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  localDevelopmentSeats: localSeats,
  verifyReconnectToken: (matchId, playerId, token) =>
    localSeats.some(
      (seat) =>
        seat.matchId === matchId &&
        seat.playerId === playerId &&
        seat.reconnectToken === token,
    ),
  currentPlayerView: ({ matchId, playerId }) =>
    matchId === LOCAL_MATCH_ID
      ? { version: state.version, view: projectPlayerView(state, playerId) }
      : null,
});
const address = await server.listen(port, "127.0.0.1");
const httpUrl = address.replace("[::1]", "127.0.0.1");
const wsUrl = httpUrl.replace(/^http/, "ws") + "/ws";
const connections = await Promise.all(
  localSeats.map((seat) => openLocalClient(wsUrl, seat)),
);
const clients = connections.map((connection) => connection.socket);

if (smoke) {
  const views = connections.map((connection) => connection.view);
  const privateViewsAreIsolated = views.every((view, viewerIndex) => {
    const serialized = JSON.stringify(view);
    return localSeats.every((_, cardIndex) =>
      cardIndex === viewerIndex
        ? serialized.includes(`local-private-card-seat-${cardIndex + 1}`)
        : !serialized.includes(`local-private-card-seat-${cardIndex + 1}`),
    );
  });
  const health = await fetch(`${httpUrl}/health`).then((response) =>
    response.json(),
  );
  const rootStatus = await fetch(`${httpUrl}/`).then(
    (response) => response.status,
  );
  if (views.length !== 6 || !privateViewsAreIsolated || rootStatus !== 200) {
    throw new Error(
      "Local six-player environment did not initialize completely.",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ status: "pass", clients: clients.length, health, rootStatus })}\n`,
  );
  for (const client of clients) client.close();
  await server.closeGracefully();
  store.close();
} else {
  process.stdout.write(
    `本地六人环境已启动：${httpUrl}\n座位凭据：${httpUrl}/dev/local-seats\n已连接本地验证 Bot：${clients.length}/6\n`,
  );
  const shutdown = async (): Promise<void> => {
    for (const client of clients) client.close();
    await server.closeGracefully();
    store.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
