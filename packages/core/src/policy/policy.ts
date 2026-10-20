import { z } from "zod";
import defaultPolicyJson from "./default-policy.json" with { type: "json" };

const SeverityOrOff = z.enum(["high", "medium", "low", "info", "off"]);
export type PolicySeverity = z.infer<typeof SeverityOrOff>;

function flag<S extends z.ZodRawShape>(params: S) {
  return z.strictObject({ severity: SeverityOrOff, ...params });
}

const FLAG_ENTRIES = {
  sanctioned_exposure: flag({}),
  mixer_direct: flag({ directHops: z.number().int().min(1) }),
  mixer_indirect: flag({ directHops: z.number().int().min(1) }),
  scam_direct: flag({ directHops: z.number().int().min(1) }),
  scam_indirect: flag({ directHops: z.number().int().min(1) }),
  common_source_across_seeds: flag({}),
  common_source_within_trace: flag({}),
  cycle: flag({}),
  funnel: flag({ minSenders: z.number().int().min(2), windowSec: z.number().int().min(1) }),
  round_trip: flag({ tolerance: z.number().min(0).max(1) }),
  structuring: flag({ minAddresses: z.number().int().min(1), maxUsd: z.number().min(0) }),
  long_chain: flag({ hops: z.number().int().min(1) }),
  unresolved_majority: flag({ share: z.number().min(0).max(1) }),
  exchange_origin: flag({}),
  spoofed_tokens_ignored: flag({}),
  incomplete_trace: flag({}),
};

export type FlagId = keyof typeof FLAG_ENTRIES;
export const FLAG_IDS = Object.keys(FLAG_ENTRIES) as FlagId[];

/** The complete set of flag settings (defaults, or defaults merged with an override). */
const ResolvedPolicySchema = z.strictObject({
  version: z.literal(1),
  flags: z.strictObject(FLAG_ENTRIES),
});
export type ResolvedFlags = z.infer<typeof ResolvedPolicySchema>["flags"];

const PARTIAL_ENTRIES: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(FLAG_ENTRIES).map(([id, schema]) => [id, schema.partial().optional()]),
);

/** User override file: any subset of flags, each with any subset of its settings. Unknown ids and settings are rejected. */
export const PolicyFileSchema = z.strictObject({
  version: z.literal(1),
  flags: z.strictObject(PARTIAL_ENTRIES).optional(),
});
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export interface LoadedPolicy {
  version: number;
  /** True when a user override file was applied. */
  overridden: boolean;
  flags: ResolvedFlags;
}

function describeIssues(label: string, error: z.ZodError): Error {
  const parts = error.issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  return new Error(`${label}: ${parts.join("; ")}`);
}

/** Validates a user policy file; the thrown message names the offending path. */
export function parsePolicyFile(json: unknown): PolicyFile {
  const result = PolicyFileSchema.safeParse(json);
  if (!result.success) throw describeIssues("Invalid policy file", result.error);
  return result.data;
}

const DEFAULT_POLICY = ResolvedPolicySchema.parse(defaultPolicyJson);

/** Merges an optional user override (per flag, per setting) onto the bundled defaults. */
export function loadPolicy(override: unknown | null): LoadedPolicy {
  if (override === null) {
    return { version: DEFAULT_POLICY.version, overridden: false, flags: DEFAULT_POLICY.flags };
  }
  const file = parsePolicyFile(override);
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [id, base] of Object.entries(DEFAULT_POLICY.flags)) merged[id] = { ...base };
  for (const [id, entry] of Object.entries(file.flags ?? {})) {
    const target = merged[id];
    if (!target || !entry) continue;
    for (const [key, value] of Object.entries(entry)) {
      if (value !== undefined) target[key] = value;
    }
  }
  const resolved = ResolvedPolicySchema.safeParse({ version: file.version, flags: merged });
  if (!resolved.success) throw describeIssues("Invalid policy file", resolved.error);
  return { version: resolved.data.version, overridden: true, flags: resolved.data.flags };
}
