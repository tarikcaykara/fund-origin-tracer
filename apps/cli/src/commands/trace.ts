import { chainHealth } from "@fot/server";
import {
  buildRunParams,
  globalsOf,
  outputOptions,
  type ParsedValues,
  type parseCli,
} from "../args.ts";
import { boot, type CliIo } from "../io.ts";
import { EXIT_FAILED, exitCodeFor, formatResult, runWithProgress, writeOutput } from "./shared.ts";

export async function traceCommand(
  parsed: ReturnType<typeof parseCli>,
  io: CliIo,
): Promise<number> {
  const values: ParsedValues = parsed.values;
  const params = buildRunParams(parsed);
  const { format, csvKind } = outputOptions(values);
  const { config, db, runtime } = await boot(globalsOf(values), io);
  try {
    if (chainHealth(config)[params.chain] !== "ready") {
      io.stderr(
        `error: ${params.chain === "tron" ? "TRONSCAN_API_KEYS" : "ETHERSCAN_API_KEY"} is not set (see .env.example)\n`,
      );
      return EXIT_FAILED;
    }
    const result = await runWithProgress(io, runtime, params, values.quiet === true);
    await writeOutput(io, formatResult(result, format, csvKind), values.out);
    return exitCodeFor(result.status);
  } finally {
    db.close();
  }
}
