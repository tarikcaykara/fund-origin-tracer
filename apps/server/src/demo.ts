import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ChainIdSchema,
  DirectionSchema,
  type OfacSet,
  type OfacSnapshot,
  ofacSetFromSnapshot,
  RunParamsSchema,
} from "@fot/core";
import { z } from "zod";

/** `<repo>/fixtures/demo`, resolved from this file so it works from any cwd. */
export const DEFAULT_FIXTURES_DIR = resolve(import.meta.dir, "../../../fixtures/demo");

export const SCENARIO_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const ScenarioSchema = z.object({
  id: z.string().regex(SCENARIO_ID_RE),
  title: z.string().min(1),
  description: z.string(),
  chain: ChainIdSchema,
  direction: DirectionSchema,
  /** `graph.addresses.length` of the recorded run; absent in scenarios recorded without counts. */
  addresses: z.number().int().nonnegative().optional(),
  /** `graph.edges.length` of the recorded run; absent in scenarios recorded without counts. */
  transfers: z.number().int().nonnegative().optional(),
  params: RunParamsSchema,
  recordedAt: z.string(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export type HttpRecording = Map<string, { status: number; body: string }>;

export interface LoadedScenario {
  scenario: Scenario;
  http: HttpRecording;
  ofac: OfacSet;
}

export function listScenarios(fixturesDir: string): Scenario[] {
  let names: string[];
  try {
    names = readdirSync(fixturesDir);
  } catch {
    return [];
  }
  const out: Scenario[] = [];
  for (const name of names.sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(fixturesDir, name, "scenario.json"), "utf8"));
      out.push(ScenarioSchema.parse(raw));
    } catch {
      // Directories without a valid scenario.json are not scenarios.
    }
  }
  return out;
}

/** Reads one scenario with its recorded HTTP traffic and OFAC snapshot; null when unknown. */
export async function loadScenario(
  fixturesDir: string,
  id: string,
): Promise<LoadedScenario | null> {
  if (!SCENARIO_ID_RE.test(id)) return null;
  const dir = join(fixturesDir, id);
  const scenarioFile = Bun.file(join(dir, "scenario.json"));
  if (!(await scenarioFile.exists())) return null;
  const scenario = ScenarioSchema.parse(await scenarioFile.json());
  const gz = new Uint8Array(await Bun.file(join(dir, "http.json.gz")).arrayBuffer());
  const record = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz))) as Record<
    string,
    { status: number; body: string }
  >;
  const ofac = ofacSetFromSnapshot(await Bun.file(join(dir, "ofac.json")).json());
  return { scenario, http: new Map(Object.entries(record)), ofac };
}

export interface ScenarioFiles {
  scenario: Scenario;
  http: HttpRecording;
  ofac: OfacSnapshot;
}

/** Writes `scenario.json`, `http.json.gz` and `ofac.json`; returns the compressed size in bytes. */
export async function writeScenario(fixturesDir: string, files: ScenarioFiles): Promise<number> {
  const dir = join(fixturesDir, files.scenario.id);
  mkdirSync(dir, { recursive: true });
  const gz = Bun.gzipSync(JSON.stringify(Object.fromEntries(files.http)));
  await Bun.write(join(dir, "http.json.gz"), gz);
  await Bun.write(join(dir, "scenario.json"), `${JSON.stringify(files.scenario, null, 2)}\n`);
  await Bun.write(join(dir, "ofac.json"), `${JSON.stringify(files.ofac)}\n`);
  return gz.byteLength;
}
