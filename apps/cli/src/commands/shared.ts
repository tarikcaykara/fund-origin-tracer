import {
  type AnalysisResult,
  type CsvKind,
  RunController,
  type RunEvent,
  type RunParams,
  toCsv,
} from "@fot/core";
import { type ExecuteRunOptions, executeRun, type Runtime } from "@fot/server";
import type { OutputFormat } from "../args.ts";
import type { CliIo } from "../io.ts";
import { renderSummary } from "../summary.ts";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_FAILED = 3;
export const EXIT_INCOMPLETE = 4;

export function exitCodeFor(status: AnalysisResult["status"]): number {
  if (status === "completed") return EXIT_OK;
  return status === "failed" ? EXIT_FAILED : EXIT_INCOMPLETE;
}

function progressLine(e: RunEvent): string | null {
  switch (e.type) {
    case "progress":
      return `[progress] expanded=${e.expandedEdges} queued=${e.queued} apiCalls=${e.apiCalls} cacheHits=${e.cacheHits} elapsed=${(e.elapsedMs / 1000).toFixed(1)}s`;
    case "warning":
      return `warning: ${e.code}: ${e.message}`;
    case "error":
      return `error: ${e.code}: ${e.message}`;
    default:
      return null;
  }
}

/** Runs one trace with progress on stderr; SIGINT/SIGTERM cancel it and return partial results. */
export async function runWithProgress(
  io: CliIo,
  runtime: Runtime,
  params: RunParams,
  quiet: boolean,
  extra: Partial<ExecuteRunOptions> = {},
): Promise<AnalysisResult> {
  const controller = new RunController();
  const onSignal = () => controller.cancel("cancelled");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await executeRun({
      params,
      runtime,
      controller,
      runId: crypto.randomUUID(),
      emit: (e) => {
        if (e.type === "error" || e.type === "warning") {
          io.stderr(`${progressLine(e)}\n`);
        } else if (!quiet) {
          const line = progressLine(e);
          if (line) io.stderr(`${line}\n`);
        }
      },
      ...extra,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export function formatResult(
  result: AnalysisResult,
  format: OutputFormat,
  csvKind: CsvKind,
): string {
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  if (format === "csv") return toCsv(csvKind, result);
  return renderSummary(result);
}

export async function writeOutput(io: CliIo, text: string, out: string | undefined): Promise<void> {
  if (out) await Bun.write(out, text);
  else await io.stdout(text);
}
