import {
  BUNDLED_LABEL_FILES,
  type CacheStore,
  CHAINS,
  type ChainId,
  type EtherscanChain,
  EtherscanV2Provider,
  type ExplorerProvider,
  emptyOfacSet,
  FotError,
  fetchTransport,
  LabelRegistry,
  type LoadedPolicy,
  type LocalLabelFile,
  loadPolicy,
  MinIntervalLimiter,
  type OfacSet,
  type OfacSnapshot,
  OfacSource,
  ofacSnapshot,
  PriceService,
  parseLocalLabelFile,
  type Transport,
  TronscanKeyPool,
  TronscanProvider,
} from "@fot/core";
import type { AppConfig } from "./config.ts";
import type { Db } from "./db.ts";

const OFAC_LOAD_TIMEOUT_MS = 90_000;
const PRICE_INTERVAL_MS = 200;

export interface ProviderOptions {
  /** Defaults to `fetchTransport`. */
  transport?: Transport;
  /** Defaults to the SQLite cache. */
  cache?: CacheStore;
  pauseGate?: () => Promise<void>;
  /**
   * Offline replay: no API keys required and no rate limiting (the transport is a recording).
   * Never set for live traffic.
   */
  replay?: boolean;
}

export interface Runtime {
  readonly config: AppConfig;
  /** Bundled + local labels + the current OFAC snapshot. */
  readonly labels: LabelRegistry;
  readonly policy: LoadedPolicy;
  readonly ofacSet: OfacSet;
  readonly ofacFetchedAt: string | null;
  readonly bootWarnings: { code: string; message: string }[];
  /** A new provider per run so `stats()` stays per run; limiter and key pool are shared. */
  explorerFor(chain: ChainId, options?: ProviderOptions): ExplorerProvider;
  pricesFor(options?: ProviderOptions): PriceService;
  /** Reloads the OFAC list (respects the refresh window) and rebuilds `labels`. */
  refreshOfac(): Promise<{ code: string; message: string } | null>;
  /** Parsed OFAC snapshot for recording; null when the list could not be loaded. */
  ofacSnapshot(): OfacSnapshot | null;
}

export interface RuntimeOptions {
  db: Db;
  /** Default transport for explorer, price and OFAC traffic (tests inject a fixture transport). */
  transport?: Transport;
  now?: () => number;
}

async function readJsonFile(kind: string, path: string): Promise<unknown> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (e) {
    throw new Error(`${kind} file ${path}: cannot read (${e instanceof Error ? e.message : e})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${kind} file ${path}: invalid JSON (${e instanceof Error ? e.message : e})`);
  }
}

async function loadLocalLabels(path: string | null): Promise<LocalLabelFile | null> {
  if (path === null) return null;
  const json = await readJsonFile("Labels", path);
  try {
    return parseLocalLabelFile(json);
  } catch (e) {
    throw new Error(`Labels file ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

async function loadPolicyFile(path: string | null): Promise<LoadedPolicy> {
  if (path === null) return loadPolicy(null);
  const json = await readJsonFile("Policy", path);
  try {
    return loadPolicy(json);
  } catch (e) {
    throw new Error(`Policy file ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Builds everything shared by the server and the CLI. An invalid labels or policy file is a boot
 * error naming the file and the Zod path; an unreachable OFAC list is only a warning.
 */
export async function createRuntime(config: AppConfig, options: RuntimeOptions): Promise<Runtime> {
  const now = options.now ?? Date.now;
  const defaultTransport = options.transport ?? fetchTransport;
  const { db } = options;

  const localLabels = await loadLocalLabels(config.labelsPath);
  const policy = await loadPolicyFile(config.policyPath);

  const etherscanLimiter = new MinIntervalLimiter(1000 / config.etherscanRps, { now });
  const priceLimiter = new MinIntervalLimiter(PRICE_INTERVAL_MS, { now });
  const keyPool =
    config.tronscanApiKeys.length > 0
      ? new TronscanKeyPool({
          keys: config.tronscanApiKeys,
          keyIntervalMs: config.tronscanKeyIntervalMs,
          globalIntervalMs: config.tronscanGlobalIntervalMs,
          now,
        })
      : null;

  const ofacSource = new OfacSource({
    url: config.ofacSdnUrl,
    transport: defaultTransport,
    kv: db.kv,
    now,
    refreshHours: config.ofacRefreshHours,
  });

  const bootWarnings: { code: string; message: string }[] = [];
  let ofacSet: OfacSet = emptyOfacSet();
  let labels = new LabelRegistry(BUNDLED_LABEL_FILES, localLabels, ofacSet);

  async function loadOfac(): Promise<{ code: string; message: string } | null> {
    const res = await ofacSource.load(AbortSignal.timeout(OFAC_LOAD_TIMEOUT_MS));
    ofacSet = res.set;
    labels = new LabelRegistry(BUNDLED_LABEL_FILES, localLabels, ofacSet);
    return res.warning;
  }

  const first = await loadOfac();
  if (first) bootWarnings.push(first);

  const runtime: Runtime = {
    config,
    get labels() {
      return labels;
    },
    policy,
    get ofacSet() {
      return ofacSet;
    },
    get ofacFetchedAt() {
      return ofacSet.fetchedAt;
    },
    bootWarnings,

    explorerFor(chain, opts = {}) {
      const transport = opts.transport ?? defaultTransport;
      const cache = opts.cache ?? db.cache;
      const pauseGate = opts.pauseGate;
      const common = {
        transport,
        cache,
        now,
        maxPages: config.explorerMaxPages,
        ...(pauseGate ? { pauseGate } : {}),
      };
      if (CHAINS[chain].kind === "evm") {
        const apiKey = opts.replay ? "replay" : config.etherscanApiKey;
        if (apiKey === "") {
          throw new FotError("invalid_api_key", "ETHERSCAN_API_KEY is not set", { fatal: true });
        }
        return new EtherscanV2Provider(chain as EtherscanChain, {
          ...common,
          apiKey,
          limiter: opts.replay ? new MinIntervalLimiter(0, { now }) : etherscanLimiter,
        });
      }
      const pool = opts.replay
        ? new TronscanKeyPool({ keys: ["replay"], keyIntervalMs: 0, globalIntervalMs: 0, now })
        : keyPool;
      if (pool === null) {
        throw new FotError("invalid_api_key", "TRONSCAN_API_KEYS is not set", { fatal: true });
      }
      return new TronscanProvider({ ...common, keyPool: pool });
    },

    pricesFor(opts = {}) {
      return new PriceService({
        transport: opts.transport ?? defaultTransport,
        cache: opts.cache ?? db.cache,
        limiter: opts.replay ? new MinIntervalLimiter(0, { now }) : priceLimiter,
        now,
        ...(opts.pauseGate ? { pauseGate: opts.pauseGate } : {}),
      });
    },

    refreshOfac: loadOfac,

    ofacSnapshot() {
      return ofacSet.fetchedAt !== null ? ofacSnapshot(ofacSet) : null;
    },
  };
  return runtime;
}
