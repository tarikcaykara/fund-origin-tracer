import {
  type AppConfig,
  createRuntime,
  type Db,
  loadConfig,
  openDb,
  type Runtime,
} from "@fot/server";

/** Everything a command touches outside its arguments, so tests can capture it. */
export interface CliIo {
  env: Record<string, string | undefined>;
  stdout(text: string): Promise<void>;
  stderr(text: string): void;
}

export class UsageError extends Error {}

export interface GlobalOptions {
  dataDir: string | undefined;
  labels: string | undefined;
  policy: string | undefined;
}

export interface Booted {
  config: AppConfig;
  db: Db;
  runtime: Runtime;
}

/** Loads config, opens the database and builds the shared runtime (labels, OFAC, policy). */
export async function boot(
  globals: GlobalOptions,
  io: CliIo,
  extra: { port?: number | undefined } = {},
): Promise<Booted> {
  const config = loadConfig(io.env, {
    dataDir: globals.dataDir,
    labelsPath: globals.labels,
    policyPath: globals.policy,
    port: extra.port,
  });
  const db = openDb(config.dataDir);
  try {
    const runtime = await createRuntime(config, { db });
    for (const w of runtime.bootWarnings) io.stderr(`warning: ${w.code}: ${w.message}\n`);
    return { config, db, runtime };
  } catch (e) {
    db.close();
    throw e;
  }
}
