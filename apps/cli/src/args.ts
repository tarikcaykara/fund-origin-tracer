import { parseArgs } from "node:util";
import type { CsvKind, RunParams } from "@fot/core";
import { LiveRunRequestSchema } from "@fot/server";
import { type GlobalOptions, UsageError } from "./io.ts";

const OPTIONS = {
  "data-dir": { type: "string" },
  labels: { type: "string" },
  policy: { type: "string" },
  help: { type: "boolean", short: "h" },
  chain: { type: "string" },
  direction: { type: "string" },
  tx: { type: "string", multiple: true },
  address: { type: "string", multiple: true },
  "max-depth": { type: "string" },
  "max-branches": { type: "string" },
  "max-edges": { type: "string" },
  "min-usd": { type: "string" },
  "through-entities": { type: "boolean" },
  "follow-unpriced": { type: "boolean" },
  timeout: { type: "string" },
  format: { type: "string" },
  "csv-kind": { type: "string" },
  out: { type: "string" },
  quiet: { type: "boolean", short: "q" },
  port: { type: "string" },
  scenario: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  "fixtures-dir": { type: "string" },
} as const;

export type ParsedValues = ReturnType<typeof parseCli>["values"];

export function parseCli(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, tokens: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

export function globalsOf(values: ParsedValues): GlobalOptions {
  return { dataDir: values["data-dir"], labels: values.labels, policy: values.policy };
}

function numberFlag(values: ParsedValues, name: keyof ParsedValues & string): number | undefined {
  const raw = values[name];
  if (typeof raw !== "string") return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
}

/** Builds validated `RunParams` from `--chain/--direction/--tx/--address/...` (seed order kept). */
export function buildRunParams(parsed: ReturnType<typeof parseCli>): RunParams {
  const { values, tokens } = parsed;
  if (!values.chain) throw new UsageError("--chain is required");
  if (!values.direction) throw new UsageError("--direction backward|forward is required");
  const seeds = tokens.flatMap((t) =>
    t.kind === "option" && (t.name === "tx" || t.name === "address") && typeof t.value === "string"
      ? [{ kind: t.name, value: t.value }]
      : [],
  );
  if (seeds.length === 0) throw new UsageError("at least one --tx or --address is required");
  const raw = {
    chain: values.chain,
    direction: values.direction,
    seeds,
    maxDepth: numberFlag(values, "max-depth"),
    maxBranches: numberFlag(values, "max-branches"),
    maxEdges: numberFlag(values, "max-edges"),
    minUsd: numberFlag(values, "min-usd"),
    traceThroughEntities: values["through-entities"],
    followUnpriced: values["follow-unpriced"],
    timeoutSec: numberFlag(values, "timeout"),
  };
  const defined = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const result = LiveRunRequestSchema.safeParse(defined);
  if (!result.success) {
    throw new UsageError(
      result.error.issues
        .map((i) => `${i.path.map(String).join(".") || "args"}: ${i.message}`)
        .join("; "),
    );
  }
  return result.data;
}

export type OutputFormat = "summary" | "json" | "csv";
export const CSV_KINDS: readonly CsvKind[] = ["edges", "convergences", "exposure", "touchpoints"];

export function outputOptions(values: ParsedValues): { format: OutputFormat; csvKind: CsvKind } {
  const format = values.format ?? "summary";
  if (format !== "summary" && format !== "json" && format !== "csv") {
    throw new UsageError("--format must be summary, json or csv");
  }
  const csvKind = values["csv-kind"] ?? "edges";
  const kind = CSV_KINDS.find((k) => k === csvKind);
  if (!kind) throw new UsageError(`--csv-kind must be one of ${CSV_KINDS.join(", ")}`);
  return { format, csvKind: kind };
}
