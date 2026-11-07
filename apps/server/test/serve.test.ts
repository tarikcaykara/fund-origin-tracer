import { expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { loadConfig, MEMORY_DB, openDb, startServer } from "../src/index.ts";
import { createTestEnv, recordDemoScenario } from "./helpers/env.ts";

/** A non-loopback IPv4 address of this machine; the bind test needs one to reach. */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && !a.internal)?.address;

async function bootServer(env: Record<string, string> = {}) {
  const config = loadConfig(
    { PORT: "0", OFAC_SDN_URL: "http://127.0.0.1:9/sdn.xml", ...env },
    { dataDir: MEMORY_DB },
  );
  return startServer(config, { db: openDb(MEMORY_DB), webDir: null });
}

/** Sends one raw HTTP/1.1 request with the given Host header and returns everything read back. */
async function rawGet(port: number, host: string): Promise<string> {
  const chunks: Buffer[] = [];
  const closed = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data: (_socket, chunk) => {
        chunks.push(chunk);
      },
      close: () => closed.resolve(),
    },
  });
  socket.write(`GET /api/health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  await closed.promise;
  return Buffer.concat(chunks).toString();
}

test.skipIf(!lanAddress)(
  "binds loopback by default and every interface only when HOST says so",
  async () => {
    for (const [env, reachable] of [
      [{}, false],
      [{ HOST: "0.0.0.0" }, true],
    ] as const) {
      const server = await bootServer(env);
      try {
        expect((await fetch(`http://127.0.0.1:${server.port}/api/health`)).status).toBe(200);
        // Any answer, a 403 for the unlisted IP included, means the address is reachable.
        const lan = fetch(`http://${lanAddress}:${server.port}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (reachable) await expect(lan).resolves.toBeInstanceOf(Response);
        else await expect(lan).rejects.toThrow();
      } finally {
        await server.stop();
      }
    }
  },
  15_000,
);

test("a rebinding Host header is refused over a real connection", async () => {
  const server = await bootServer();
  try {
    const refused = await rawGet(server.port, `rebound.example:${server.port}`);
    expect(refused).toStartWith("HTTP/1.1 403");
    expect(refused).toContain("host_not_allowed");
    expect(await rawGet(server.port, `localhost:${server.port}`)).toStartWith("HTTP/1.1 200");
  } finally {
    await server.stop();
  }
});

// Real sockets and the platform clock on purpose: Bun's idle timeout cannot run on fake timers.
// Bun checks idle timeouts on a 4 s tick, so the waits below span a few ticks.
test("idle keep-alive connections are closed while event streams stay open", async () => {
  const recorder = await createTestEnv();
  const demoId = await recordDemoScenario(recorder.runtime, recorder.fixturesDir);
  const config = loadConfig(
    { PORT: "0", OFAC_SDN_URL: "http://127.0.0.1:9/sdn.xml" },
    { dataDir: MEMORY_DB },
  );
  const server = await startServer(config, {
    db: openDb(MEMORY_DB),
    fixturesDir: recorder.fixturesDir,
    webDir: null,
    idleTimeout: 1,
    manager: { replayDelayMs: 50 },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;

    // The event stream of a paused run stays silent: keepalives come only every 15 s.
    const started = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ demo: demoId }),
    });
    const { runId } = (await started.json()) as { runId: string };
    expect((await fetch(`${base}/api/runs/${runId}/pause`, { method: "POST" })).status).toBe(200);
    const reader = (await fetch(`${base}/api/runs/${runId}/events`)).body?.getReader();
    if (!reader) throw new Error("event stream has no body");
    let streamEnded = false;
    const drained = (async () => {
      try {
        while (!(await reader.read()).done) {}
      } catch {
        // A reset connection ends the stream too.
      }
      streamEnded = true;
    })();

    // A connection that idles after its request is closed by the idle timeout.
    const closed = Promise.withResolvers<"closed">();
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {}, close: () => closed.resolve("closed") },
    });
    socket.write("GET /api/health HTTP/1.1\r\nHost: localhost\r\n\r\n");
    expect(await Promise.race([closed.promise, Bun.sleep(9000).then(() => "open")])).toBe("closed");

    // One more tick: a stream under the idle timeout would be gone by now.
    await Bun.sleep(4500);
    expect(streamEnded).toBe(false);
    await reader.cancel();
    await drained;
    await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" });
  } finally {
    await server.stop();
  }
}, 30_000);
