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
  readonly allowedOrigins?: readonly string[];
  readonly maxUnauthenticatedConnections?: number;
  readonly onAuthenticated?: (
    seat: AuthenticatedSeat,
    reconnectToken: string,
  ) => Promise<void> | void;
  readonly onDisconnected?: (seat: AuthenticatedSeat) => Promise<void> | void;
}

export interface AppServer {
  readonly app: FastifyInstance;
  readonly listen: (port: number, host?: string) => Promise<string>;
  readonly closeGracefully: () => Promise<void>;
  readonly publishPlayerViews: (
    matchId: MatchId,
    viewFor: (playerId: PlayerId) =>
      | Promise<{ readonly version: number; readonly view: unknown }>
      | {
          readonly version: number;
          readonly view: unknown;
        },
  ) => Promise<void>;
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
  const authenticatedSockets = new Map<
    string,
    { readonly socket: WebSocket; readonly seat: AuthenticatedSeat }
  >();
  let unauthenticatedConnections = 0;
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

  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: (request, reply, done) => {
        const origin = request.headers.origin;
        if (
          options.allowedOrigins !== undefined &&
          (origin === undefined || !options.allowedOrigins.includes(origin))
        ) {
          reply.code(403).send({ error: "origin-not-allowed" });
          return;
        }
        done();
      },
    },
    (socket) => {
      unauthenticatedConnections += 1;
      if (
        unauthenticatedConnections >
        (options.maxUnauthenticatedConnections ?? 100)
      ) {
        unauthenticatedConnections -= 1;
        socket.close(1013, "connection-capacity");
        return;
      }
      const connectionId = randomUUID();
      let authenticatedSeat: AuthenticatedSeat | null = null;
      let rateTokens = 40;
      let rateUpdatedAt = Date.now();
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
          const rateNow = Date.now();
          rateTokens = Math.min(
            40,
            rateTokens + ((rateNow - rateUpdatedAt) / 1_000) * 20,
          );
          rateUpdatedAt = rateNow;
          if (rateTokens < 1) {
            send(socket, {
              type: "error",
              category: "rate-limited",
              code: "message-rate-exceeded",
              retryable: true,
            });
            return;
          }
          rateTokens -= 1;
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
            unauthenticatedConnections -= 1;
            clearTimeout(authenticationTimer);
            const seatKey = `${message.matchId}\0${message.playerId}`;
            const previous = authenticatedSockets.get(seatKey);
            authenticatedSockets.set(seatKey, {
              socket,
              seat: authenticatedSeat,
            });
            if (previous !== undefined && previous.socket !== socket) {
              previous.socket.close(4000, "connection-replaced");
            }
            await options.onAuthenticated?.(
              authenticatedSeat,
              message.reconnectToken,
            );
            send(socket, {
              type: "authenticated",
              matchId: message.matchId,
              playerId: message.playerId,
              connectionId,
            });
            const current =
              await options.currentPlayerView?.(authenticatedSeat);
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
          app.log.error(
            { err: error, connectionId },
            "websocket-message-failed",
          );
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
        if (authenticatedSeat === null) {
          unauthenticatedConnections = Math.max(
            0,
            unauthenticatedConnections - 1,
          );
          return;
        }
        const seatKey = `${authenticatedSeat.matchId}\0${authenticatedSeat.playerId}`;
        if (authenticatedSockets.get(seatKey)?.socket === socket) {
          authenticatedSockets.delete(seatKey);
          const disconnectedSeat = authenticatedSeat;
          void Promise.resolve()
            .then(() => options.onDisconnected?.(disconnectedSeat))
            .catch((error: unknown) => {
              app.log.error(
                { err: error, connectionId },
                "websocket-disconnect-hook-failed",
              );
            });
        }
      });
    },
  );

  return {
    app,
    listen: (port, host = "127.0.0.1") => app.listen({ port, host }),
    publishPlayerViews: async (matchId, viewFor) => {
      const recipients = [...authenticatedSockets.values()].filter(
        ({ seat }) => seat.matchId === matchId,
      );
      await Promise.all(
        recipients.map(async ({ seat, socket }) => {
          const projected = await viewFor(seat.playerId);
          send(socket, {
            type: "player-view",
            matchId,
            version: projected.version,
            view: projected.view,
          });
        }),
      );
    },
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
