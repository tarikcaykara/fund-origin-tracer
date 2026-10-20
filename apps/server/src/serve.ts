import { createApp } from "./app.ts";
import type { AppConfig } from "./config.ts";
import { type Db, openDb } from "./db.ts";
import { RunManager, type RunManagerOptions } from "./runs.ts";
import { createRuntime, type Runtime } from "./runtime.ts";

const HOUR_MS = 3_600_000;

export interface ServerOptions {
  /** Open database to use instead of `<dataDir>/fot.sqlite`. */
  db?: Db;
  fixturesDir?: string;
  webDir?: string | null;
  manager?: Pick<RunManagerOptions, "replayDelayMs" | "maxLiveRuns">;
}

export interface RunningServer {
  port: number;
  runtime: Runtime;
  manager: RunManager;
  stop(): Promise<void>;
}

/** Boots the HTTP server: database, labels/OFAC/policy, run manager, maintenance timers. */
export async function startServer(
  config: AppConfig,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const db = options.db ?? openDb(config.dataDir);
  db.investigations.markInterrupted();
  const runtime = await createRuntime(config, { db });
  const manager = new RunManager({
    runtime,
    db,
    ...(options.fixturesDir ? { fixturesDir: options.fixturesDir } : {}),
    ...options.manager,
  });
  const app = createApp({
    runtime,
    manager,
    ...(options.webDir !== undefined ? { webDir: options.webDir } : {}),
  });

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    // SSE streams are long-lived; keepalive comments keep proxies happy.
    idleTimeout: 0,
  });

  const timers = [
    setInterval(() => db.cache.prune(), HOUR_MS),
    setInterval(() => {
      void runtime.refreshOfac().then((warning) => {
        if (warning) console.warn(`[ofac] ${warning.message}`);
      });
    }, Math.max(1, config.ofacRefreshHours) * HOUR_MS),
  ];
  for (const t of timers) t.unref();

  return {
    port: server.port ?? config.port,
    runtime,
    manager,
    async stop() {
      for (const t of timers) clearInterval(t);
      await manager.shutdown();
      await server.stop(true);
      db.close();
    },
  };
}
