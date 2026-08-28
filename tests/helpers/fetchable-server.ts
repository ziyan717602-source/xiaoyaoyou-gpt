interface TestServer {
  listen(port: number, host?: string): Promise<string>;
  closeGracefully(): Promise<void>;
}

/** OS port 0 can select a port blocked by the Fetch standard (observed as
 * undici `bad port`). Probe with the actual runtime instead of bypassing its
 * security list or maintaining a stale copy. Rebuild only on that failure. */
export async function startFetchableServer<T extends TestServer>(
  build: () => Promise<T>,
  probe: (url: string) => Promise<{ readonly ok: boolean }> = fetch,
): Promise<{ server: T; httpUrl: string }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const server = await build();
    try {
      const httpUrl = await server.listen(0, "127.0.0.1");
      const health = await probe(`${httpUrl}/health`);
      if (!health.ok) throw new Error("HTTP integration health probe failed.");
      return { server, httpUrl };
    } catch (error) {
      await server.closeGracefully();
      if (!(
        error instanceof TypeError &&
        error.cause instanceof Error &&
        error.cause.message === "bad port"
      ))
        throw error;
    }
  }
  throw new Error("Could not allocate a fetch-compatible ephemeral HTTP port.");
}
