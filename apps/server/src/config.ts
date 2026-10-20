import { CHAIN_IDS, CHAINS, type ChainId } from "@fot/core";
import { z } from "zod";

const DEFAULT_OFAC_URL =
  "https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.xml";

/** Empty or whitespace-only values behave like unset variables (`.env.example` ships blanks). */
const blankToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

const intFrom = (min: number, max: number, fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));

const boolFrom = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
  z
    .enum(["", "true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
);

const EnvSchema = z.object({
  PORT: intFrom(0, 65535, 3000),
  DATA_DIR: z.preprocess(blankToUndefined, z.string().default("./data")),
  ETHERSCAN_API_KEY: z.preprocess(blankToUndefined, z.string().trim().default("")),
  ETHERSCAN_RPS: z.preprocess(blankToUndefined, z.coerce.number().min(0.1).max(100).default(3)),
  TRONSCAN_API_KEYS: z.preprocess(
    blankToUndefined,
    z
      .string()
      .default("")
      .transform((s) => [
        ...new Set(
          s
            .split(",")
            .map((k) => k.trim())
            .filter((k) => k !== ""),
        ),
      ]),
  ),
  TRONSCAN_KEY_INTERVAL_MS: intFrom(0, 600_000, 2000),
  TRONSCAN_GLOBAL_INTERVAL_MS: intFrom(0, 600_000, 500),
  EXPLORER_MAX_PAGES: intFrom(1, 4, 2),
  ENGINE_CONCURRENCY: intFrom(1, 32, 4),
  FOT_LABELS_PATH: optional(z.string()),
  FOT_POLICY_PATH: optional(z.string()),
  OFAC_SDN_URL: z.preprocess(blankToUndefined, z.url().default(DEFAULT_OFAC_URL)),
  OFAC_REFRESH_HOURS: z.preprocess(blankToUndefined, z.coerce.number().min(0.1).default(24)),
  DEMO_ONLY: boolFrom,
});

export interface AppConfig {
  port: number;
  dataDir: string;
  etherscanApiKey: string;
  etherscanRps: number;
  tronscanApiKeys: string[];
  tronscanKeyIntervalMs: number;
  tronscanGlobalIntervalMs: number;
  explorerMaxPages: number;
  engineConcurrency: number;
  labelsPath: string | null;
  policyPath: string | null;
  ofacSdnUrl: string;
  ofacRefreshHours: number;
  demoOnly: boolean;
}

export interface ConfigOverrides {
  dataDir?: string | undefined;
  labelsPath?: string | undefined;
  policyPath?: string | undefined;
  port?: number | undefined;
}

export type ChainHealth = "ready" | "missing_key";

/** Parses the environment table; the thrown message names every offending variable. */
export function loadConfig(
  env: Record<string, string | undefined>,
  overrides: ConfigOverrides = {},
): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new Error(`Invalid configuration: ${issues.join("; ")}`);
  }
  const e = parsed.data;
  return {
    port: overrides.port ?? e.PORT,
    dataDir: overrides.dataDir ?? e.DATA_DIR,
    etherscanApiKey: e.ETHERSCAN_API_KEY,
    etherscanRps: e.ETHERSCAN_RPS,
    tronscanApiKeys: e.TRONSCAN_API_KEYS,
    tronscanKeyIntervalMs: e.TRONSCAN_KEY_INTERVAL_MS,
    tronscanGlobalIntervalMs: e.TRONSCAN_GLOBAL_INTERVAL_MS,
    explorerMaxPages: e.EXPLORER_MAX_PAGES,
    engineConcurrency: e.ENGINE_CONCURRENCY,
    labelsPath: overrides.labelsPath ?? e.FOT_LABELS_PATH ?? null,
    policyPath: overrides.policyPath ?? e.FOT_POLICY_PATH ?? null,
    ofacSdnUrl: e.OFAC_SDN_URL,
    ofacRefreshHours: e.OFAC_REFRESH_HOURS,
    demoOnly: e.DEMO_ONLY,
  };
}

export function chainHealth(config: AppConfig): Record<ChainId, ChainHealth> {
  const out = {} as Record<ChainId, ChainHealth>;
  for (const id of CHAIN_IDS) {
    const hasKey =
      CHAINS[id].kind === "evm" ? config.etherscanApiKey !== "" : config.tronscanApiKeys.length > 0;
    out[id] = hasKey ? "ready" : "missing_key";
  }
  return out;
}
