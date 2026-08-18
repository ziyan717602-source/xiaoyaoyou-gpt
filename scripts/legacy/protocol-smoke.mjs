import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const runtimeRoot = join(workspaceRoot, "artifacts", "oracle", "bin");
const artifactPath = join(
  workspaceRoot,
  "artifacts",
  "oracle",
  "protocol-smoke.json",
);
const roomOffset = 73;
const port = 40_201 + roomOffset;
let sequence = 0;
const trace = [];

function encode7BitInteger(value) {
  const bytes = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function encodeDotNetString(value) {
  const content = Buffer.from(value, "utf8");
  return Buffer.concat([encode7BitInteger(content.length), content]);
}

function decode7BitInteger(buffer) {
  let result = 0;
  let shift = 0;
  for (let index = 0; index < Math.min(buffer.length, 5); index += 1) {
    const byte = buffer[index];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { bytes: index + 1, value: result };
    shift += 7;
  }
  return null;
}

class LegacyClient {
  constructor(index) {
    this.index = index;
    this.name = `Oracle${index}`;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    this.socket = null;
  }

  async connect() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await new Promise((resolveConnect, rejectConnect) => {
          const socket = createConnection({ host: "127.0.0.1", port });
          const onError = (error) => {
            socket.destroy();
            rejectConnect(error);
          };
          socket.once("error", onError);
          socket.once("connect", () => {
            socket.off("error", onError);
            this.socket = socket;
            socket.on("data", (chunk) => this.onData(chunk));
            socket.on("error", () => undefined);
            resolveConnect();
          });
        });
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    }
    throw new Error(`Client ${this.index} could not connect to port ${port}.`);
  }

  send(message) {
    trace.push({
      sequence: (sequence += 1),
      client: this.index,
      direction: "in",
      message,
    });
    this.socket.write(encodeDotNetString(message));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      const prefix = decode7BitInteger(this.buffer);
      if (prefix === null || this.buffer.length < prefix.bytes + prefix.value)
        return;
      const message = this.buffer
        .subarray(prefix.bytes, prefix.bytes + prefix.value)
        .toString("utf8");
      this.buffer = this.buffer.subarray(prefix.bytes + prefix.value);
      this.messages.push(message);
      trace.push({
        sequence: (sequence += 1),
        client: this.index,
        direction: "out",
        message,
      });
      const pending = this.waiters;
      this.waiters = [];
      for (const waiter of pending) {
        if (waiter.predicate(message)) waiter.resolve(message);
        else this.waiters.push(waiter);
      }
    }
  }

  waitFor(prefix, timeoutMs = 10_000) {
    const existing = this.messages.find((message) =>
      message.startsWith(prefix),
    );
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolveMessage, rejectMessage) => {
      const waiter = {
        predicate: (message) => message.startsWith(prefix),
        resolve: (message) => {
          clearTimeout(timer);
          resolveMessage(message);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        rejectMessage(
          new Error(`Client ${this.index} timed out waiting for ${prefix}.`),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    this.socket?.destroy();
  }
}

function family(message) {
  return message.split(",", 1)[0];
}

const standardOutput = [];
const standardError = [];
const server = spawn(
  join(runtimeRoot, "PSDGamepkg.exe"),
  ["0", "NT", "RM", "NJ", "2", String(roomOffset)],
  { cwd: runtimeRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => standardOutput.push(chunk));
server.stderr.on("data", (chunk) => standardError.push(chunk));

const clients = Array.from(
  { length: 6 },
  (_, index) => new LegacyClient(index + 1),
);

try {
  for (const client of clients) {
    await client.connect();
    client.send(`C2CO,0,${client.name},${client.index},0`);
    const assigned = await client.waitFor("C2CN,");
    client.assignedUid = Number.parseInt(assigned.slice("C2CN,".length), 10);
  }

  await Promise.all(clients.map((client) => client.waitFor("C2SA,")));
  for (const client of clients) client.send(`C2ST,${client.assignedUid}`);
  await Promise.all(clients.map((client) => client.waitFor("H0SD,")));
  await Promise.all(clients.map((client) => client.waitFor("H0SL,")));

  const outgoing = trace.filter((entry) => entry.direction === "out");
  const recipientsByMessage = new Map();
  for (const entry of outgoing) {
    const recipients = recipientsByMessage.get(entry.message) ?? new Set();
    recipients.add(entry.client);
    recipientsByMessage.set(entry.message, recipients);
  }
  const visibility = [...recipientsByMessage.entries()]
    .map(([message, recipients]) => ({
      family: family(message),
      recipients: [...recipients].sort((left, right) => left - right),
      classification:
        recipients.size === 6 ? "broadcast" : "connection-specific",
    }))
    .sort((left, right) =>
      left.family === right.family
        ? left.recipients.join(",").localeCompare(right.recipients.join(","))
        : left.family.localeCompare(right.family),
    );

  const artifact = {
    schemaVersion: 1,
    transport:
      ".NET BinaryWriter.Write(string): 7-bit UTF-8 byte length + bytes",
    serverArgs: ["0", "NT", "RM", "NJ", "2", "<room-offset>"],
    clients: clients.map((client) => ({
      index: client.index,
      name: client.name,
      assignedUid: client.assignedUid,
      receivedFamilies: [...new Set(client.messages.map(family))].sort(),
    })),
    visibility,
    trace,
    serverStdout: standardOutput.join("").split(/\r?\n/u).filter(Boolean),
    serverStderr: standardError.join("").split(/\r?\n/u).filter(Boolean),
  };
  mkdirSync(join(workspaceRoot, "artifacts", "oracle"), { recursive: true });
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log(
    `Legacy protocol smoke passed: ${trace.length} frames, families ${[
      ...new Set(trace.map((entry) => family(entry.message))),
    ]
      .sort()
      .join(", ")}.`,
  );
} catch (error) {
  mkdirSync(join(workspaceRoot, "artifacts", "oracle"), { recursive: true });
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        error: error instanceof Error ? error.message : String(error),
        trace,
        serverStdout: standardOutput.join("").split(/\r?\n/u).filter(Boolean),
        serverStderr: standardError.join("").split(/\r?\n/u).filter(Boolean),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  throw error;
} finally {
  for (const client of clients) client.close();
  server.kill();
}
