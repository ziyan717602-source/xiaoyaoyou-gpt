import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildRoomServer } from "./room-server.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PORT must be an integer from 0 through 65535.");
}
const host = process.env.HOST ?? "127.0.0.1";
const databasePath =
  process.env.DATABASE_PATH ?? join(process.cwd(), ".local", "rooms.sqlite");
if (databasePath !== ":memory:") {
  mkdirSync(dirname(databasePath), { recursive: true });
}
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ??
  "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3000,http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
if (allowedOrigins.length === 0) {
  throw new Error("ALLOWED_ORIGINS must contain at least one explicit origin.");
}

const server = await buildRoomServer({
  databasePath,
  allowedOrigins,
});
const address = await server.listen(port, host);
process.stdout.write(`逍遥游房间服务已启动：${address}\n`);

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await server.closeGracefully();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
