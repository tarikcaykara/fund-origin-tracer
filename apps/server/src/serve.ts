import { createApp } from "./app.ts";
import type { AppConfig } from "./config.ts";
import { type Db, openDb } from "./db.ts";
import { scheduleOfacRefresh } from "./ofac-refresh.ts";
import { RunManager, type RunManagerOptions } from "./runs.ts";
import { createRuntime, type Runtime } from "./runtime.ts";

const HOUR_MS = 3_600_000;

/** Transport ceiling for every route; `/api/*` bodies are limited further (`MAX_BODY_BYTES`). */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export interface ServerOptions {
  /** Open database to use instead of `<dataDir>/fot.sqlite`. */
  db?: Db;
  fixturesDir?: string;
  webDir?: string | null;
  manager?: Pick<RunManagerOptions, "replayDelayMs" | "maxLiveRuns">;
  /** Seconds before an idle connection is closed; Bun's default (10) when unset. */
  idleTimeout?: number;
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
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // Event streams turn the idle timeout off for themselves (`app.ts`); every other connection
    // keeps it, so idle sockets cannot pile up.
    ...(options.idleTimeout !== undefined ? { idleTimeout: options.idleTimeout } : {}),
  });

  const prune = setInterval(() => db.cache.prune(), HOUR_MS);
  prune.unref();
  const ofacRefresh = scheduleOfacRefresh({
    runtime,
    refreshHours: config.ofacRefreshHours,
    onWarning: (message) => console.warn(`[ofac] ${message}`),
  });

  return {
    port: server.port ?? config.port,
    runtime,
    manager,
    async stop() {
      clearInterval(prune);
      ofacRefresh.stop();
      await manager.shutdown();
      await server.stop(true);
      db.close();
    },
  };
}
