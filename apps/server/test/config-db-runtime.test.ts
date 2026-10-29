import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  chainHealth,
  createRuntime,
  loadConfig,
  MEMORY_DB,
  openDb,
  SqliteCacheStore,
} from "../src/index.ts";
import { tempDir } from "./helpers/env.ts";
import { fakeTransport } from "./helpers/fake-etherscan.ts";

describe("loadConfig", () => {
  test("applies the documented defaults to an empty environment", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 3000,
      dataDir: "./data",
      etherscanApiKey: "",
      etherscanRps: 3,
      tronscanApiKeys: [],
      tronscanKeyIntervalMs: 2000,
      tronscanGlobalIntervalMs: 500,
      explorerMaxPages: 2,
      engineConcurrency: 4,
      labelsPath: null,
      policyPath: null,
      ofacRefreshHours: 24,
      demoOnly: false,
    });
  });

  test("treats blank values like unset ones (as shipped in .env.example)", () => {
    const c = loadConfig({ ETHERSCAN_API_KEY: "", PORT: "", FOT_LABELS_PATH: "", DEMO_ONLY: "" });
    expect(c.port).toBe(3000);
    expect(c.labelsPath).toBeNull();
    expect(c.demoOnly).toBe(false);
  });

  test("splits comma-separated Tronscan keys and parses booleans", () => {
    const c = loadConfig({ TRONSCAN_API_KEYS: " k1, k2 ,,k1", DEMO_ONLY: "true" });
    expect(c.tronscanApiKeys).toEqual(["k1", "k2"]);
    expect(c.demoOnly).toBe(true);
  });

  test("rejects EXPLORER_MAX_PAGES outside 1-4 and names the variable", () => {
    expect(() => loadConfig({ EXPLORER_MAX_PAGES: "5" })).toThrow(/EXPLORER_MAX_PAGES/);
    expect(() => loadConfig({ EXPLORER_MAX_PAGES: "0" })).toThrow(/EXPLORER_MAX_PAGES/);
    expect(loadConfig({ EXPLORER_MAX_PAGES: "4" }).explorerMaxPages).toBe(4);
    expect(() => loadConfig({ DEMO_ONLY: "maybe" })).toThrow(/DEMO_ONLY/);
  });

  test("overrides win over the environment", () => {
    const c = loadConfig(
      { PORT: "1", DATA_DIR: "/a", FOT_LABELS_PATH: "/l", FOT_POLICY_PATH: "/p" },
      { port: 9, dataDir: "/b", labelsPath: "/x", policyPath: "/y" },
    );
    expect(c).toMatchObject({ port: 9, dataDir: "/b", labelsPath: "/x", policyPath: "/y" });
  });

  test("chainHealth needs the Etherscan key for EVM chains and a Tronscan key for TRON", () => {
    expect(chainHealth(loadConfig({}))).toEqual({
      ethereum: "missing_key",
      polygon: "missing_key",
      arbitrum: "missing_key",
      tron: "missing_key",
    });
    expect(chainHealth(loadConfig({ ETHERSCAN_API_KEY: "k" }))).toEqual({
      ethereum: "ready",
      polygon: "ready",
      arbitrum: "ready",
      tron: "missing_key",
    });
    expect(chainHealth(loadConfig({ TRONSCAN_API_KEYS: "t" })).tron).toBe("ready");
  });
});

describe("database", () => {
  test("sets the schema version and persists across reopen", () => {
    const dir = tempDir();
    const db = openDb(dir);
    expect(
      (db.sqlite.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(1);
    db.investigations.insert({
      id: "x",
      chain: "ethereum",
      direction: "backward",
      seeds: [],
      params: {} as never,
      status: "completed",
      title: "t",
      demo: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.close();
    const again = openDb(dir);
    expect(again.investigations.get("x")?.title).toBe("t");
    again.close();
  });

  test("markInterrupted turns running rows into interrupted and leaves others alone", () => {
    const db = openDb(MEMORY_DB);
    const base = {
      chain: "ethereum" as const,
      direction: "backward" as const,
      seeds: [],
      params: {} as never,
      title: null,
      demo: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    db.investigations.insert({ ...base, id: "r", status: "running" });
    db.investigations.insert({ ...base, id: "c", status: "completed" });
    expect(db.investigations.markInterrupted()).toBe(1);
    expect(db.investigations.get("r")?.status).toBe("interrupted");
    expect(db.investigations.get("c")?.status).toBe("completed");
  });

  test("cache honours TTLs and prunes expired rows", async () => {
    let now = 1_000_000;
    const db = openDb(MEMORY_DB, { now: () => now });
    await db.cache.set("short", "a", 10);
    await db.cache.set("long", "b", 1000);
    expect(await db.cache.get("short")).toBe("a");
    now += 11_000;
    expect(await db.cache.get("short")).toBeNull();
    expect(db.cache.prune().expired).toBe(1);
    expect(await db.cache.get("long")).toBe("b");
  });

  test("cache past the row cap drops the 10% with the oldest expiry", async () => {
    const db = openDb(MEMORY_DB);
    const cache = new SqliteCacheStore(db.sqlite, () => 0, 100);
    for (let i = 0; i < 150; i++) await cache.set(`k${i}`, "v", 1000 + i);
    const { evicted } = cache.prune();
    expect(evicted).toBe(15);
    expect(await cache.get("k0")).toBeNull();
    expect(await cache.get("k14")).toBeNull();
    expect(await cache.get("k15")).toBe("v");
    expect(await cache.get("k149")).toBe("v");
  });

  test("kv stores and overwrites values", async () => {
    const db = openDb(MEMORY_DB);
    expect(await db.kv.get("a")).toBeNull();
    await db.kv.set("a", "1");
    await db.kv.set("a", "2");
    expect(await db.kv.get("a")).toBe("2");
  });
});

describe("runtime", () => {
  const boot = (env: Record<string, string> = {}) => {
    const db = openDb(MEMORY_DB);
    const config = loadConfig({ ETHERSCAN_API_KEY: "k", ...env });
    return createRuntime(config, { db, transport: fakeTransport([]) });
  };

  test("an invalid labels file is a boot error naming the file and the path", async () => {
    const file = join(tempDir(), "labels.json");
    await Bun.write(
      file,
      JSON.stringify({
        entries: [{ chain: "ethereum", address: "zzz", name: "x", category: "other" }],
      }),
    );
    await expect(boot({ FOT_LABELS_PATH: file })).rejects.toThrow(
      new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*entries\\.0\\.address`),
    );
  });

  test("an invalid policy file is a boot error naming the file and the path", async () => {
    const file = join(tempDir(), "policy.json");
    await Bun.write(file, JSON.stringify({ version: 1, flags: { cycle: { severity: "loud" } } }));
    await expect(boot({ FOT_POLICY_PATH: file })).rejects.toThrow(/policy\.json.*cycle/);
  });

  test("a missing or non-JSON file is a boot error", async () => {
    await expect(boot({ FOT_LABELS_PATH: "/nonexistent/labels.json" })).rejects.toThrow(
      /labels\.json/,
    );
    const file = join(tempDir(), "p.json");
    await Bun.write(file, "{nope");
    await expect(boot({ FOT_POLICY_PATH: file })).rejects.toThrow(/invalid JSON/);
  });

  test("valid local labels and policy are applied", async () => {
    const dir = tempDir();
    const labels = join(dir, "labels.json");
    const policy = join(dir, "policy.json");
    const mine = "0x00000000000000000000000000000000000000aa";
    await Bun.write(
      labels,
      JSON.stringify({
        entries: [
          { chain: "ethereum", address: mine, name: "Our hot wallet", category: "exchange" },
        ],
      }),
    );
    await Bun.write(policy, JSON.stringify({ version: 1, flags: { cycle: { severity: "off" } } }));
    const rt = await boot({ FOT_LABELS_PATH: labels, FOT_POLICY_PATH: policy });
    expect(rt.labels.lookup("ethereum", mine)[0]).toMatchObject({
      name: "Our hot wallet",
      origin: "local",
    });
    expect(rt.policy.overridden).toBe(true);
    expect(rt.policy.flags.cycle.severity).toBe("off");
  });

  test("an unreachable OFAC list is only a boot warning", async () => {
    const db = openDb(MEMORY_DB);
    const rt = await createRuntime(loadConfig({}), {
      db,
      transport: async () => ({ status: 503, body: "down" }),
    });
    expect(rt.bootWarnings.map((w) => w.code)).toEqual(["ofac_unavailable"]);
    expect(rt.ofacSnapshot()).toBeNull();
    expect(rt.ofacFetchedAt).toBeNull();
  });

  test("a loaded OFAC list is stored and reused from the database", async () => {
    const db = openDb(MEMORY_DB);
    let fetches = 0;
    const transport = async () => {
      fetches++;
      return {
        status: 200,
        body: "<sdnEntry><uid>7</uid><lastName>TEST ENTITY</lastName><sdnType>Entity</sdnType><idList><id><idType>Digital Currency Address - ETH</idType><idNumber>0x00000000000000000000000000000000000000bb</idNumber></id></idList></sdnEntry>",
      };
    };
    const first = await createRuntime(loadConfig({}), { db, transport });
    expect(
      first.labels.isSanctioned("ethereum", "0x00000000000000000000000000000000000000BB"),
    ).toBe(true);
    const second = await createRuntime(loadConfig({}), { db, transport });
    expect(fetches).toBe(1);
    expect(second.ofacFetchedAt).toBe(first.ofacFetchedAt);
    expect(second.labels.lookup("ethereum", `0x${"0".repeat(38)}bb`)[0]?.name).toBe("TEST ENTITY");
  });

  test("explorerFor builds a fresh provider per run and requires a key for live traffic", async () => {
    const rt = await boot();
    const a = rt.explorerFor("ethereum");
    const b = rt.explorerFor("polygon");
    expect(a).not.toBe(rt.explorerFor("ethereum"));
    expect(b.chain).toBe("polygon");
    expect(() => rt.explorerFor("tron")).toThrow(/TRONSCAN_API_KEYS/);
    expect(rt.explorerFor("tron", { replay: true }).chain).toBe("tron");
  });
});
