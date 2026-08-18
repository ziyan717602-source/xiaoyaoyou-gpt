import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { PROTOCOL_VERSION, type ServerMessage } from "@xiaoyaoyou/protocol";
import { WebSocketServer } from "ws";

export interface AppServer {
  readonly httpServer: ReturnType<typeof createServer>;
  readonly webSocketServer: WebSocketServer;
}

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({
        status: "ok",
        service: "xiaoyaoyou-server",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    return;
  }

  response.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: "not-found" }));
}

export function buildServer(): AppServer {
  const httpServer = createServer(handleHttp);
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    path: "/ws",
  });

  webSocketServer.on("connection", (socket) => {
    const hello: ServerMessage = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
    };
    socket.send(JSON.stringify(hello));
  });

  return { httpServer, webSocketServer };
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const { httpServer } = buildServer();

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`xiaoyaoyou-server listening on http://0.0.0.0:${port}`);
  });
}
