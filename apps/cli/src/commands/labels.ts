import { parseBundledLabelFile, parseLocalLabelFile } from "@fot/core";
import type { parseCli } from "../args.ts";
import type { CliIo } from "../io.ts";
import { UsageError } from "../io.ts";
import { EXIT_FAILED, EXIT_OK } from "./shared.ts";

/** `fot labels validate <file>`: bundled format when the JSON has a `chain`, else local format. */
export async function labelsCommand(
  parsed: ReturnType<typeof parseCli>,
  io: CliIo,
): Promise<number> {
  const [, sub, file] = parsed.positionals;
  if (sub !== "validate" || !file || parsed.positionals.length > 3) {
    throw new UsageError("usage: fot labels validate <file>");
  }
  let json: unknown;
  try {
    json = JSON.parse(await Bun.file(file).text());
  } catch (e) {
    io.stderr(`FAIL ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_FAILED;
  }
  const bundled = typeof json === "object" && json !== null && "chain" in json;
  try {
    const parsedFile = bundled ? parseBundledLabelFile(json) : parseLocalLabelFile(json);
    await io.stdout(
      `OK ${file}: ${parsedFile.entries.length} entries (${bundled ? "bundled" : "local"} format)\n`,
    );
    return EXIT_OK;
  } catch (e) {
    io.stderr(`FAIL ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_FAILED;
  }
}
