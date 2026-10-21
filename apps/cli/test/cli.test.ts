import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RunController } from "@fot/core";
import { createRuntime, executeRun, loadConfig, MEMORY_DB, openDb } from "@fot/server";
import { tempDir } from "../../server/test/helpers/env.ts";
import {
  chainOfTransfers,
  fakeTransport,
  txHash,
} from "../../server/test/helpers/fake-etherscan.ts";
import { runCli } from "../src/cli.ts";
import { formatResult } from "../src/commands/shared.ts";
import type { CliIo } from "../src/io.ts";

const LABELS_DIR = join(import.meta.dir, "../../../packages/core/labels");
const ETH_ADDRESS = "0x28c6c06298d514db089934071355e5743bf21d60";

let ofacServer: ReturnType<typeof Bun.serve>;
let baseEnv: Record<string, string>;

beforeAll(() => {
  // OFAC is the only network call the CLI makes at boot; point it at a local stub.
  ofacServer = Bun.serve({ port: 0, fetch: () => new Response("<sdnList/>") });
  baseEnv = {
    OFAC_SDN_URL: `http://localhost:${ofacServer.port}/sdn.xml`,
    DATA_DIR: tempDir("fot-cli-data-"),
  };
});
afterAll(() => ofacServer.stop(true));

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(argv: string[], env: Record<string, string> = {}): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    env: { ...baseEnv, ...env },
    stdout: async (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

describe("usage errors exit with code 2", () => {
  const cases: [string, string[], RegExp][] = [
    ["no command", [], /missing command/],
    ["unknown command", ["frobnicate"], /unknown command/],
    ["unknown flag", ["trace", "--nope"], /nope/],
    [
      "missing chain",
      ["trace", "--direction", "backward", "--tx", txHash(1)],
      /--chain is required/,
    ],
    ["missing direction", ["trace", "--chain", "ethereum", "--tx", txHash(1)], /--direction/],
    ["no seeds", ["trace", "--chain", "ethereum", "--direction", "backward"], /--tx or --address/],
    [
      "invalid chain",
      ["trace", "--chain", "btc", "--direction", "backward", "--tx", txHash(1)],
      /chain/,
    ],
    [
      "seed invalid for the chain",
      ["trace", "--chain", "tron", "--direction", "backward", "--tx", txHash(1)],
      /seeds\.0\.value/,
    ],
    [
      "non-numeric limit",
      [
        "trace",
        "--chain",
        "ethereum",
        "--direction",
        "backward",
        "--tx",
        txHash(1),
        "--max-depth",
        "deep",
      ],
      /--max-depth must be a number/,
    ],
    [
      "out-of-range limit",
      [
        "trace",
        "--chain",
        "ethereum",
        "--direction",
        "backward",
        "--tx",
        txHash(1),
        "--max-depth",
        "99",
      ],
      /maxDepth/,
    ],
    [
      "bad format",
      [
        "trace",
        "--chain",
        "ethereum",
        "--direction",
        "backward",
        "--tx",
        txHash(1),
        "--format",
        "xml",
      ],
      /--format/,
    ],
    [
      "bad csv kind",
      [
        "trace",
        "--chain",
        "ethereum",
        "--direction",
        "backward",
        "--tx",
        txHash(1),
        "--csv-kind",
        "x",
      ],
      /--csv-kind/,
    ],
    ["screen without address", ["screen", "--chain", "ethereum"], /usage: fot screen/],
    ["screen with invalid address", ["screen", "--chain", "ethereum", "0x123"], /not a valid/],
    ["labels without subcommand", ["labels"], /usage: fot labels validate/],
    ["serve with bad port", ["serve", "--port", "70000"], /--port/],
    ["fixtures without scenario", ["fixtures", "record"], /--scenario/],
  ];
  for (const [name, argv, message] of cases) {
    test(name, async () => {
      const r = await cli(argv);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(r.stdout).toBe("");
    });
  }

  test("--help prints usage with exit 0", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fot trace");
  });
});

describe("fot trace without a key", () => {
  test("fails with exit 3 and says which variable is missing", async () => {
    const r = await cli(
      ["trace", "--chain", "ethereum", "--direction", "backward", "--tx", txHash(1)],
      { ETHERSCAN_API_KEY: "" },
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("ETHERSCAN_API_KEY");
  });

  test("an invalid labels file fails the command, naming the file", async () => {
    const file = join(tempDir(), "bad-labels.json");
    await Bun.write(file, JSON.stringify({ entries: [{ nope: 1 }] }));
    const r = await cli(
      [
        "trace",
        "--chain",
        "ethereum",
        "--direction",
        "backward",
        "--tx",
        txHash(1),
        "--labels",
        file,
      ],
      { ETHERSCAN_API_KEY: "k" },
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("bad-labels.json");
  });
});

describe("fot labels validate", () => {
  for (const chain of ["ethereum", "polygon", "arbitrum", "tron"]) {
    test(`accepts the bundled ${chain} labels`, async () => {
      const file = join(LABELS_DIR, `${chain}.json`);
      const r = await cli(["labels", "validate", file]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/OK .* \d+ entries \(bundled format\)/);
    });
  }

  test("accepts a local override file", async () => {
    const file = join(tempDir(), "local.json");
    await Bun.write(
      file,
      JSON.stringify({
        entries: [{ chain: "ethereum", address: ETH_ADDRESS, name: "Mine", category: "other" }],
      }),
    );
    const r = await cli(["labels", "validate", file]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("local format");
  });

  test("rejects a bundled file without sources, naming the Zod path", async () => {
    const file = join(tempDir(), "bundled.json");
    await Bun.write(
      file,
      JSON.stringify({
        chain: "ethereum",
        entries: [
          { address: ETH_ADDRESS, name: "X", category: "exchange", verifiedAt: "2026-01-01" },
        ],
      }),
    );
    const r = await cli(["labels", "validate", file]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("entries.0.source");
  });

  test("rejects invalid JSON and missing files", async () => {
    const file = join(tempDir(), "x.json");
    await Bun.write(file, "{");
    expect((await cli(["labels", "validate", file])).code).toBe(3);
    expect((await cli(["labels", "validate", join(tempDir(), "missing.json")])).code).toBe(3);
  });

  test("requires a file argument", async () => {
    expect((await cli(["labels", "validate"])).code).toBe(2);
  });
});

describe("fot screen", () => {
  test("prints bundled labels for a known exchange address", async () => {
    const r = await cli(["screen", "--chain", "ethereum", ETH_ADDRESS]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Binance");
    expect(r.stdout).toContain("Sanctioned (OFAC SDN): no");
  });

  test("honours a local label file", async () => {
    const file = join(tempDir(), "local.json");
    const mine = "0x00000000000000000000000000000000000000aa";
    await Bun.write(
      file,
      JSON.stringify({
        entries: [{ chain: "ethereum", address: mine, name: "Our cold wallet", category: "other" }],
      }),
    );
    const r = await cli(["screen", "--chain", "ethereum", mine, "--labels", file]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Our cold wallet");
  });
});

describe("output formats", () => {
  async function sampleResult() {
    const db = openDb(MEMORY_DB);
    const config = loadConfig({ ETHERSCAN_API_KEY: "k", ETHERSCAN_RPS: "100" });
    const runtime = await createRuntime(config, {
      db,
      transport: fakeTransport(chainOfTransfers(8)),
    });
    return executeRun({
      params: {
        chain: "ethereum",
        direction: "backward",
        seeds: [{ id: "s1", kind: "tx", value: txHash(1) }],
        maxDepth: 3,
        maxBranches: 3,
        maxEdges: 50,
        minUsd: 0,
        traceThroughEntities: false,
        followUnpriced: false,
        timeoutSec: 60,
      },
      runtime,
      controller: new RunController(),
      emit: () => {},
      runId: "run-1",
    });
  }

  test("summary lists risk level, flags, exposure, linked wallets, touchpoints and stats", async () => {
    const text = formatResult(await sampleResult(), "summary", "edges");
    expect(text).toMatch(/^Risk level: (LOW|MEDIUM|HIGH)$/m);
    expect(text).toContain("Flags (");
    expect(text).toContain("Exposure by category:");
    expect(text).toContain("Linked wallets (");
    expect(text).toContain("Exchange touchpoints (");
    expect(text).toMatch(/Stats: .*apiCalls=\d+ cacheHits=\d+/);
  });

  test("summary aligns the exposure table columns", async () => {
    const result = await sampleResult();
    result.exposure.byCategory = [
      {
        category: "exchange",
        direct: { count: 1, usd: 5 },
        indirect: { count: 12, usd: 1234.5, minHops: 2 },
      },
      {
        category: "mixer",
        direct: { count: 0, usd: 0 },
        indirect: { count: 1, usd: 1, minHops: 4 },
      },
    ];
    const lines = formatResult(result, "summary", "edges").split("\n");
    const start = lines.findIndex((l) => l.includes("category") && l.includes("min_hops"));
    const header = lines[start] as string;
    const column = header.indexOf("direct_usd");
    expect(lines[start + 1]?.slice(column, column + 5)).toBe("$5.00");
    expect(lines[start + 2]?.slice(column, column + 5)).toBe("$0.00");
  });

  test("json round-trips the result and csv starts with the BOM and the edge header", async () => {
    const result = await sampleResult();
    expect(JSON.parse(formatResult(result, "json", "edges")).runId).toBe("run-1");
    expect(formatResult(result, "csv", "edges").startsWith("\uFEFFdepth,from,")).toBe(true);
    expect(formatResult(result, "csv", "exposure").startsWith("\uFEFFcategory,")).toBe(true);
  });
});
