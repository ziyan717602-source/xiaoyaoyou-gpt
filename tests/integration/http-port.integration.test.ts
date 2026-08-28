import { describe, expect, it } from "vitest";
import { startFetchableServer } from "../helpers/fetchable-server.js";

describe("HTTP integration ephemeral port guard", () => {
  it("proves the runtime rejects a blocked port before opening a connection", async () => {
    await expect(fetch("http://127.0.0.1:10080/health")).rejects.toMatchObject({
      cause: { message: "bad port" },
    });
  });
  it("closes a blocked server before allocating again without suppressing other errors", async () => {
    const closed: number[] = [],
      built: number[] = [];
    const build = async () => {
      const id = built.length;
      built.push(id);
      return {
        listen: async () => `http://127.0.0.1:${id === 0 ? 10080 : 20000}`,
        closeGracefully: async () => {
          closed.push(id);
        },
      };
    };
    const result = await startFetchableServer(build, async (url) => {
      if (url.includes(":10080"))
        throw new TypeError("fetch failed", { cause: new Error("bad port") });
      expect(closed).toEqual([0]);
      return { ok: true };
    });
    expect(result.httpUrl).toBe("http://127.0.0.1:20000");
    await result.server.closeGracefully();
    expect(closed).toEqual([0, 1]);
  });
  it("closes and surfaces ordinary startup/probe failures, with no retry", async () => {
    let closed = 0,
      built = 0;
    await expect(
      startFetchableServer(
        async () => {
          built++;
          return {
            listen: async () => "http://127.0.0.1:20000",
            closeGracefully: async () => {
              closed++;
            },
          };
        },
        async () => {
          throw new Error("real failure");
        },
      ),
    ).rejects.toThrow("real failure");
    expect([built, closed]).toEqual([1, 1]);
  });
  it("bounds repeated blocked-port retries and closes every allocated server", async () => {
    let closed = 0;
    await expect(
      startFetchableServer(
        async () => ({
          listen: async () => "http://127.0.0.1:10080",
          closeGracefully: async () => {
            closed++;
          },
        }),
        async () => {
          throw new TypeError("fetch failed", { cause: new Error("bad port") });
        },
      ),
    ).rejects.toThrow("fetch-compatible");
    expect(closed).toBe(8);
  });
});
