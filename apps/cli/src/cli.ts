import { parseCli } from "./args.ts";
import { fixturesCommand } from "./commands/fixtures.ts";
import { labelsCommand } from "./commands/labels.ts";
import { screenCommand } from "./commands/screen.ts";
import { serveCommand } from "./commands/serve.ts";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./commands/shared.ts";
import { traceCommand } from "./commands/trace.ts";
import { type CliIo, UsageError } from "./io.ts";

export const USAGE = `fot - fund-origin-tracer

Usage:
  fot trace --chain <id> --direction backward|forward (--tx <hash>|--address <addr>)... [options]
  fot screen --chain <id> <address>
  fot labels validate <file>
  fot serve [--port <n>]
  fot fixtures record --scenario <id> --title <t> --description <d> <trace flags>

Trace options:
  --max-depth <n>  --max-branches <n>  --max-edges <n>  --min-usd <n>  --timeout <sec>
  --through-entities  --follow-unpriced  --format summary|json|csv
  --csv-kind edges|convergences|exposure|touchpoints|addresses
  --out <file>  --quiet

Global options:
  --data-dir <dir>  --labels <file>  --policy <file>

Chains: ethereum, polygon, arbitrum, tron
Exit codes: 0 completed, 2 usage error, 3 failed, 4 cancelled or timed out
`;

export const defaultIo: CliIo = {
  env: process.env,
  stdout: (text) => Bun.write(Bun.stdout, text).then(() => undefined),
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Runs the CLI and returns the exit code; never calls `process.exit`. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  try {
    const parsed = parseCli(argv);
    const command = parsed.positionals[0];
    if (parsed.values.help || command === "help") {
      await io.stdout(USAGE);
      return EXIT_OK;
    }
    switch (command) {
      case "trace":
        return await traceCommand(parsed, io);
      case "screen":
        return await screenCommand(parsed, io);
      case "labels":
        return await labelsCommand(parsed, io);
      case "serve":
        return await serveCommand(parsed, io);
      case "fixtures":
        return await fixturesCommand(parsed, io);
      case undefined:
        throw new UsageError("missing command");
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`error: ${e.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    io.stderr(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_FAILED;
  }
}
