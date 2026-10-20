import {
  BUNDLED_LABEL_FILES,
  fetchTransport,
  LabelRegistry,
  MemoryCacheStore,
  RecordingTransport,
} from "@fot/core";
import {
  chainHealth,
  DEFAULT_FIXTURES_DIR,
  type HttpRecording,
  SCENARIO_ID_RE,
  writeScenario,
} from "@fot/server";
import { buildRunParams, globalsOf, outputOptions, type parseCli } from "../args.ts";
import { boot, type CliIo, UsageError } from "../io.ts";
import { EXIT_FAILED, exitCodeFor, formatResult, runWithProgress, writeOutput } from "./shared.ts";

const MAX_FIXTURE_BYTES = 3 * 1024 * 1024;

/**
 * `fot fixtures record`: runs a live trace through a recording transport (engine concurrency 1 and
 * a fresh in-memory cache, exactly like demo replay) and writes the scenario files.
 */
export async function fixturesCommand(
  parsed: ReturnType<typeof parseCli>,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parsed;
  if (positionals[1] !== "record" || positionals.length > 2) {
    throw new UsageError(
      "usage: fot fixtures record --scenario <id> --title <t> --description <d> ...",
    );
  }
  const id = values.scenario;
  if (!id || !SCENARIO_ID_RE.test(id)) {
    throw new UsageError("--scenario <id> is required (lowercase letters, digits and dashes)");
  }
  if (!values.title) throw new UsageError("--title is required");
  if (values.description === undefined) throw new UsageError("--description is required");
  const params = buildRunParams(parsed);
  const { format, csvKind } = outputOptions(values);

  const { config, db, runtime } = await boot(globalsOf(values), io);
  try {
    if (chainHealth(config)[params.chain] !== "ready") {
      io.stderr(`error: no API key configured for ${params.chain} (see .env.example)\n`);
      return EXIT_FAILED;
    }
    const snapshot = runtime.ofacSnapshot();
    if (snapshot === null) {
      io.stderr(
        "error: the OFAC SDN list could not be loaded; refusing to record a scenario without it\n",
      );
      return EXIT_FAILED;
    }

    const http: HttpRecording = new Map();
    const result = await runWithProgress(io, runtime, params, values.quiet === true, {
      transport: RecordingTransport(fetchTransport, (rec) =>
        http.set(rec.key, { status: rec.status, body: rec.body }),
      ),
      cache: new MemoryCacheStore(Date.now),
      concurrency: 1,
      labels: new LabelRegistry(BUNDLED_LABEL_FILES, null, runtime.ofacSet),
      ofacFetchedAt: snapshot.fetchedAt,
    });
    await writeOutput(io, formatResult(result, format, csvKind), values.out);
    if (result.status !== "completed") {
      io.stderr(`error: run ended as ${result.status}; no fixtures written\n`);
      return exitCodeFor(result.status);
    }

    const dir = values["fixtures-dir"] ?? DEFAULT_FIXTURES_DIR;
    const bytes = await writeScenario(dir, {
      scenario: {
        id,
        title: values.title,
        description: values.description,
        chain: params.chain,
        direction: params.direction,
        params: result.params,
        recordedAt: new Date().toISOString(),
      },
      http,
      ofac: snapshot,
    });
    io.stderr(
      `recorded ${http.size} responses (${(bytes / 1024).toFixed(0)} KiB gz) -> ${dir}/${id}\n`,
    );
    if (bytes > MAX_FIXTURE_BYTES) {
      io.stderr("warning: http.json.gz exceeds 3 MB; re-record with a smaller --max-edges\n");
    }
    return exitCodeFor(result.status);
  } finally {
    db.close();
  }
}
