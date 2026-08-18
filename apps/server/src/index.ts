import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { collectDefaultMetrics, Registry } from "prom-client";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type CommandEnvelope,
  type MatchId,
  type PlayerId,
  type ServerMessage,
  validateClientMessage,
} from "@xiaoyaoyou/protocol";
import type { WebSocket } from "ws";

const HEARTBEAT_MS = 25_000;
const AUTHENTICATION_DEADLINE_MS = 5_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

export interface AuthenticatedSeat {
  readonly matchId: MatchId;
  readonly playerId: PlayerId;
}

export interface BuildServerOptions {
  readonly logger?: boolean;
  readonly verifyReconnectToken?: (
    matchId: MatchId,
    playerId: PlayerId,
    reconnectToken: string,
  ) => Promise<boolean> | boolean;
  readonly currentPlayerView?: (
    seat: AuthenticatedSeat,
  ) =>
    | Promise<{ readonly version: number; readonly view: unknown } | null>
    | { readonly version: number; readonly view: unknown }
    | null;
  readonly handleCommand?: (
    seat: AuthenticatedSeat,
    command: CommandEnvelope,
  ) => Promise<ServerMessage>;
  readonly staticRoot?: string;
  readonly localDevelopmentSeats?: readonly {
    readonly matchId: MatchId;
    readonly playerId: PlayerId;
    readonly reconnectToken: string;
  }[];
  readonly exposeMetrics?: boolean;
}

export interface AppServer {
  readonly app: FastifyInstance;
  readonly listen: (port: number, host?: string) => Promise<string>;
  readonly closeGracefully: () => Promise<void>;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function decodeMessage(raw: Buffer): ClientMessage | null {
  if (raw.byteLength > MAX_MESSAGE_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    const validation = validateClientMessage(parsed);
    return validation.ok ? (validation.value ?? null) : null;
  } catch {
    return null;
  }
}

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<AppServer> {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "xiaoyaoyou_" });
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            redact: {
              paths: [
                "req.headers.authorization",
                "reconnectToken",
                "*.reconnectToken",
                "seed",
                "*.seed",
                "hand",
                "*.hand",
              ],
              censor: "[REDACTED]",
            },
          },
    bodyLimit: MAX_MESSAGE_BYTES,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  await app.register(websocket, {
    options: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false },
  });

  if (options.staticRoot !== undefined) {
    await app.register(staticFiles, {
      root: options.staticRoot,
      prefix: "/",
      index: ["index.html"],
    });
  }

  app.get("/health", async () => ({
    status: "ok",
    service: "xiaoyaoyou-server",
    protocolVersion: PROTOCOL_VERSION,
  }));

  app.get("/ready", async () => ({ status: "ready" }));

  if (options.exposeMetrics === true) {
    app.get("/metrics", async (_request, reply) => {
      reply.header("content-type", registry.contentType);
      return registry.metrics();
    });
  }

  if (options.localDevelopmentSeats !== undefined) {
    app.get("/dev/local-seats", async () => ({
      warning: "local-development-only",
      seats: options.localDevelopmentSeats,
    }));
  }

  app.get("/ws", { websocket: true }, (socket) => {
    const connectionId = randomUUID();
    let authenticatedSeat: AuthenticatedSeat | null = null;
    const authenticationTimer = setTimeout(() => {
      if (authenticatedSeat === null) {
        socket.close(4408, "authentication-timeout");
      }
    }, AUTHENTICATION_DEADLINE_MS);
    authenticationTimer.unref?.();

    send(socket, {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      connectionId,
      heartbeatMs: HEARTBEAT_MS,
      authenticationDeadlineMs: AUTHENTICATION_DEADLINE_MS,
    });

    socket.on("message", (raw) => {
      void (async () => {
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : Buffer.from(raw);
        const message = decodeMessage(bytes);
        if (message === null) {
          send(socket, {
            type: "error",
            category: "invalid",
            code: "invalid-message",
            retryable: false,
          });
          return;
        }

        if (authenticatedSeat === null) {
          if (message.type !== "authenticate") {
            send(socket, {
              type: "error",
              category: "unauthenticated",
              code: "authenticate-first",
              retryable: false,
            });
            return;
          }
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            send(socket, {
              type: "error",
              category: "invalid",
              code: "unsupported-protocol-version",
              retryable: false,
            });
            socket.close(4406, "unsupported-protocol-version");
            return;
          }
          const verified =
            (await options.verifyReconnectToken?.(
              message.matchId,
              message.playerId,
              message.reconnectToken,
            )) ?? false;
          if (!verified) {
            send(socket, {
              type: "error",
              category: "unauthenticated",
              code: "authentication-failed",
              retryable: false,
            });
            socket.close(4401, "authentication-failed");
            return;
          }
          authenticatedSeat = {
            matchId: message.matchId,
            playerId: message.playerId,
          };
          clearTimeout(authenticationTimer);
          send(socket, {
            type: "authenticated",
            matchId: message.matchId,
            playerId: message.playerId,
            connectionId,
          });
          const current = await options.currentPlayerView?.(authenticatedSeat);
          if (current !== undefined && current !== null) {
            send(socket, {
              type: "player-view",
              matchId: message.matchId,
              version: current.version,
              view: current.view,
            });
          }
          return;
        }

        if (message.type === "ping") {
          send(socket, { type: "pong", nonce: message.nonce });
          return;
        }
        if (message.type !== "command") {
          send(socket, {
            type: "error",
            category: "invalid",
            code: "already-authenticated",
            retryable: false,
          });
          return;
        }
        if (
          message.envelope.matchId !== authenticatedSeat.matchId ||
          message.envelope.playerId !== authenticatedSeat.playerId
        ) {
          send(socket, {
            type: "command-rejected",
            commandId: message.envelope.commandId,
            category: "forbidden",
            reason: "forbidden",
            currentVersion: message.envelope.expectedVersion,
            retryable: false,
          });
          return;
        }
        const response = (await options.handleCommand?.(
          authenticatedSeat,
          message.envelope,
        )) ?? {
          type: "command-rejected",
          commandId: message.envelope.commandId,
          category: "unavailable",
          reason: "not-available",
          currentVersion: message.envelope.expectedVersion,
          retryable: true,
        };
        send(socket, response);
      })().catch((error: unknown) => {
        app.log.error({ err: error, connectionId }, "websocket-message-failed");
        send(socket, {
          type: "error",
          category: "internal",
          code: "internal-error",
          retryable: true,
        });
      });
    });

    socket.on("close", () => {
      clearTimeout(authenticationTimer);
    });
  });

  return {
    app,
    listen: (port, host = "127.0.0.1") => app.listen({ port, host }),
    closeGracefully: async () => {
      for (const client of app.websocketServer.clients) {
        send(client, { type: "server-draining", retryAfterMs: 1_000 });
        client.close(1012, "service-restart");
      }
      await app.close();
      registry.clear();
    },
  };
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const server = await buildServer();
  await server.listen(port, "0.0.0.0");
}

export { DeadlineScheduler, MatchActor } from "./match-actor.js";
export { SqliteEventStore } from "./persistence.js";
