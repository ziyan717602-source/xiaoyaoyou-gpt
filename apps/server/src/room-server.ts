import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PlayerId, RoomId } from "@xiaoyaoyou/protocol";
import {
  buildServer,
  type AppServer,
  type BuildServerOptions,
} from "./index.js";
import {
  RoomError,
  SqliteRoomStore,
  type RoomMutationResult,
} from "./room-store.js";
import { MatchService } from "./match-service.js";

interface RoomServerOptions {
  readonly databasePath: string;
  readonly logger?: boolean;
  readonly allowedOrigins?: readonly string[];
}

export interface RoomAppServer extends AppServer {
  readonly roomStore: SqliteRoomStore;
  readonly matchService: MatchService;
}

interface Bucket {
  count: number;
  resetAt: number;
}

class FixedWindowLimiter {
  readonly #buckets = new Map<string, Bucket>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  consume(key: string, now = Date.now()): boolean {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count += 1;
    return true;
  }
}

const nicknameSchema = { type: "string", minLength: 1, maxLength: 64 } as const;
const idSchema = { type: "string", minLength: 1, maxLength: 128 } as const;
const mutationBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["playerId", "commandId", "expectedVersion"],
  properties: {
    playerId: idSchema,
    commandId: idSchema,
    expectedVersion: { type: "integer", minimum: 0 },
  },
} as const;

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new RoomError("forbidden", 403);
  }
  const token = authorization.slice("Bearer ".length);
  if (token.length < 32 || token.length > 256) {
    throw new RoomError("forbidden", 403);
  }
  return token;
}

export async function buildRoomServer(
  options: RoomServerOptions,
): Promise<RoomAppServer> {
  const roomStore = new SqliteRoomStore(options.databasePath);
  let closing = false;
  let server!: AppServer;
  let matchService!: MatchService;
  const publishRoom = async (roomId: RoomId): Promise<void> => {
    if (closing) return;
    await server.publishPlayerViews(roomId, (playerId) => {
      const room = roomStore.seatedView(roomId, playerId);
      return { version: room.version, view: room };
    });
  };
  const publishMatch = async (matchId: RoomId): Promise<void> => {
    if (closing) return;
    await server.publishPlayerViews(matchId, (playerId) =>
      matchService.view(matchId, playerId),
    );
  };
  const publishCurrent = async (roomId: RoomId): Promise<void> => {
    const room = roomStore.seatedView(roomId, roomStore.hostPlayerId(roomId));
    if (room.status === "started") await publishMatch(roomId);
    else await publishRoom(roomId);
  };
  const scheduleCurrentPublish = (roomId: RoomId): void => {
    queueMicrotask(() => {
      void publishCurrent(roomId).catch((error: unknown) => {
        server.app.log.error({ err: error, roomId }, "room-publish-failed");
      });
    });
  };
  matchService = new MatchService(options.databasePath, publishMatch);

  const buildOptions: BuildServerOptions = {
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: options.allowedOrigins }),
    verifyReconnectToken: (roomId, playerId, token) =>
      roomStore.authenticate(roomId, playerId, token),
    currentPlayerView: ({ matchId, playerId }) => {
      const room = roomStore.seatedView(matchId, playerId);
      return room.status === "started"
        ? matchService.view(matchId, playerId)
        : { version: room.version, view: room };
    },
    handleCommand: (_seat, envelope) => matchService.handleCommand(envelope),
    onAuthenticated: async ({ matchId, playerId }, token) => {
      const now = Date.now();
      const room = roomStore.markConnected(matchId, playerId, token, now);
      if (room.status === "started") {
        await matchService.setPresence(matchId, playerId, "connected", now);
      }
      scheduleCurrentPublish(matchId);
    },
    onDisconnected: async ({ matchId, playerId }) => {
      if (closing) return;
      const now = Date.now();
      const room = roomStore.markDisconnected(matchId, playerId, now);
      if (room.status === "started") {
        await matchService.setPresence(matchId, playerId, "disconnected", now);
      }
      scheduleCurrentPublish(matchId);
    },
  };
  server = await buildServer(buildOptions);
  for (const presence of roomStore.activeMatchPresences()) {
    await matchService.activate(presence);
  }
  const app: FastifyInstance = server.app;
  const generalLimiter = new FixedWindowLimiter(40, 1_000);
  const roomCreationLimiter = new FixedWindowLimiter(12, 60_000);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RoomError) {
      reply.code(error.statusCode).send({ error: error.code });
      return;
    }
    if ((error as { validation?: unknown }).validation !== undefined) {
      reply.code(400).send({ error: "invalid-request" });
      return;
    }
    app.log.error({ err: error }, "room-route-failed");
    reply.code(500).send({ error: "internal-error" });
  });

  const rateLimit = (request: FastifyRequest, strict = false): void => {
    const allowed = generalLimiter.consume(request.ip);
    const strictAllowed = !strict || roomCreationLimiter.consume(request.ip);
    if (!allowed || !strictAllowed) {
      throw new RoomError("rate-limited", 429);
    }
  };

  app.post<{ Body: { nickname: string } }>(
    "/api/rooms",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["nickname"],
          properties: { nickname: nicknameSchema },
        },
      },
    },
    async (request, reply) => {
      rateLimit(request, true);
      const session = roomStore.createRoom(request.body.nickname);
      reply.header("cache-control", "no-store").code(201);
      return session;
    },
  );

  app.post<{ Body: { inviteCode: string; nickname: string } }>(
    "/api/rooms/join",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["inviteCode", "nickname"],
          properties: {
            inviteCode: { type: "string", minLength: 8, maxLength: 8 },
            nickname: nicknameSchema,
          },
        },
      },
    },
    async (request, reply) => {
      rateLimit(request, true);
      const session = roomStore.joinRoom(
        request.body.inviteCode,
        request.body.nickname,
      );
      await publishRoom(session.room.roomId);
      reply.header("cache-control", "no-store").code(201);
      return session;
    },
  );

  app.get<{ Params: { roomId: string }; Querystring: { playerId: string } }>(
    "/api/rooms/:roomId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["roomId"],
          properties: { roomId: idSchema },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["playerId"],
          properties: { playerId: idSchema },
        },
      },
    },
    async (request) => {
      rateLimit(request);
      return roomStore.privateView(
        request.params.roomId,
        request.query.playerId,
        bearerToken(request),
      );
    },
  );

  app.post<{
    Params: { roomId: string };
    Body: {
      playerId: string;
      commandId: string;
      expectedVersion: number;
      ready: boolean;
    };
  }>(
    "/api/rooms/:roomId/ready",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["roomId"],
          properties: { roomId: idSchema },
        },
        body: {
          ...mutationBodySchema,
          required: [...mutationBodySchema.required, "ready"],
          properties: {
            ...mutationBodySchema.properties,
            ready: { type: "boolean" },
          },
        },
      },
    },
    async (request): Promise<RoomMutationResult> => {
      rateLimit(request);
      const result = roomStore.setReady({
        roomId: request.params.roomId,
        playerId: request.body.playerId,
        token: bearerToken(request),
        commandId: request.body.commandId,
        expectedVersion: request.body.expectedVersion,
        ready: request.body.ready,
      });
      await publishRoom(request.params.roomId);
      return result;
    },
  );

  for (const action of ["start", "end"] as const) {
    app.post<{
      Params: { roomId: string };
      Body: {
        playerId: string;
        commandId: string;
        expectedVersion: number;
      };
    }>(
      `/api/rooms/:roomId/${action}`,
      {
        schema: {
          params: {
            type: "object",
            additionalProperties: false,
            required: ["roomId"],
            properties: { roomId: idSchema },
          },
          body: mutationBodySchema,
        },
      },
      async (request): Promise<RoomMutationResult> => {
        rateLimit(request);
        const input = {
          roomId: request.params.roomId,
          playerId: request.body.playerId,
          token: bearerToken(request),
          commandId: request.body.commandId,
          expectedVersion: request.body.expectedVersion,
        };
        const result =
          action === "start"
            ? roomStore.startRoom(input)
            : roomStore.endRoom(input);
        if (action === "start" && !result.duplicate) {
          await matchService.activate(
            roomStore.matchPresence(request.params.roomId),
          );
        }
        await publishRoom(request.params.roomId);
        return result;
      },
    );
  }

  return {
    ...server,
    roomStore,
    matchService,
    closeGracefully: async () => {
      closing = true;
      const disconnectedAt = Date.now();
      for (const presence of roomStore.activeMatchPresences()) {
        for (const player of presence.players) {
          if (!player.connected) continue;
          roomStore.markDisconnected(
            presence.matchId,
            player.playerId,
            disconnectedAt,
          );
          await matchService.setPresence(
            presence.matchId,
            player.playerId,
            "disconnected",
            disconnectedAt,
          );
        }
      }
      await server.closeGracefully();
      await matchService.close();
      roomStore.close();
    },
  };
}
