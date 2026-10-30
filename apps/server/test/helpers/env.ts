import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_LABEL_FILES,
  LabelRegistry,
  MemoryCacheStore,
  RecordingTransport,
  RunController,
  type RunParams,
  type Transport,
} from "@fot/core";
import {
  type AppConfig,
  createApp,
  createRuntime,
  type Db,
  executeRun,
  type HttpRecording,
  loadConfig,
  MEMORY_DB,
  openDb,
  RunManager,
  type Runtime,
  writeScenario,
} from "../../src/index.ts";
import { addr, chainOfTransfers, fakeTransport, txHash } from "./fake-etherscan.ts";

export interface TestEnv {
  db: Db;
  runtime: Runtime;
  manager: RunManager;
  app: ReturnType<typeof createApp>;
  config: AppConfig;
  fixturesDir: string;
}

export function tempDir(prefix = "fot-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface EnvOptions {
  env?: Record<string, string>;
  transport?: Transport;
  fixturesDir?: string;
  maxLiveRuns?: number;
  provisionalIntervalMs?: number;
}

/** Server wired to an in-memory database and a fake explorer; no network, no keys needed. */
export async function createTestEnv(options: EnvOptions = {}): Promise<TestEnv> {
  const config = loadConfig(
    { ETHERSCAN_API_KEY: "test-key", ETHERSCAN_RPS: "100", ...options.env },
    { dataDir: MEMORY_DB },
  );
  const db = openDb(MEMORY_DB);
  const runtime = await createRuntime(config, {
    db,
    transport: options.transport ?? fakeTransport(chainOfTransfers(8)),
  });
  const fixturesDir = options.fixturesDir ?? tempDir();
  const manager = new RunManager({
    runtime,
    db,
    fixturesDir,
    replayDelayMs: 0,
    ...(options.maxLiveRuns ? { maxLiveRuns: options.maxLiveRuns } : {}),
    ...(options.provisionalIntervalMs
      ? { provisionalIntervalMs: options.provisionalIntervalMs }
      : {}),
  });
  const app = createApp({ runtime, manager, webDir: null });
  return { db, runtime, manager, app, config, fixturesDir };
}

export const LIVE_SEED_TX = txHash(1);

export function liveBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chain: "ethereum",
    direction: "backward",
    seeds: [{ kind: "tx", value: LIVE_SEED_TX }],
    maxDepth: 2,
    maxEdges: 50,
    ...extra,
  };
}

export function post(path: string, body: unknown): [string, RequestInit] {
  return [
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  ];
}

/** Records a tiny demo scenario like `fot fixtures record`, but without the optional counts, and returns its id. */
export async function recordDemoScenario(
  runtime: Runtime,
  fixturesDir: string,
  id = "demo-chain",
): Promise<string> {
  const params: RunParams = {
    chain: "ethereum",
    direction: "backward",
    seeds: [{ id: "s1", kind: "tx", value: LIVE_SEED_TX }],
    maxDepth: 3,
    maxBranches: 3,
    maxEdges: 50,
    minUsd: 0,
    traceThroughEntities: false,
    followUnpriced: false,
    timeoutSec: 60,
  };
  const http: HttpRecording = new Map();
  const snapshot = runtime.ofacSnapshot();
  if (!snapshot) throw new Error("test OFAC snapshot missing");
  const result = await executeRun({
    params,
    runtime,
    controller: new RunController(),
    emit: () => {},
    runId: "recording",
    transport: RecordingTransport(fakeTransport(chainOfTransfers(8)), (r) =>
      http.set(r.key, { status: r.status, body: r.body }),
    ),
    cache: new MemoryCacheStore(Date.now),
    concurrency: 1,
    labels: new LabelRegistry(BUNDLED_LABEL_FILES, null, runtime.ofacSet),
    ofacFetchedAt: snapshot.fetchedAt,
  });
  await writeScenario(fixturesDir, {
    scenario: {
      id,
      title: "Demo chain",
      description: "Synthetic scenario for tests",
      chain: params.chain,
      direction: params.direction,
      params: result.params,
      recordedAt: new Date().toISOString(),
    },
    http,
    ofac: snapshot,
  });
  return id;
}

export { addr };
