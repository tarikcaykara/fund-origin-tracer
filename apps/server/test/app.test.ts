import { describe, expect, test } from "bun:test";
import type { AnalysisResult, RunEvent } from "@fot/core";
import { createTestEnv, liveBody, post, recordDemoScenario, type TestEnv } from "./helpers/env.ts";
import { chainOfTransfers, fakeTransport, txHash } from "./helpers/fake-etherscan.ts";

async function startLive(env: TestEnv, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await env.app.request(...post("/api/runs", liveBody(extra)));
  expect(res.status).toBe(201);
  return ((await res.json()) as { runId: string }).runId;
}

async function readEvents(env: TestEnv, runId: string): Promise<RunEvent[]> {
  const res = await env.app.request(`/api/runs/${runId}/events`);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  const events: RunEvent[] = [];
  for (const block of text.split("\n\n")) {
    const data = block.split("\n").find((l) => l.startsWith("data: "));
    if (data) events.push(JSON.parse(data.slice(6)) as RunEvent);
  }
  return events;
}

async function getRun(env: TestEnv, runId: string) {
  const res = await env.app.request(`/api/runs/${runId}`);
  return (await res.json()) as {
    status: string;
    riskLevel: string | null;
    result: AnalysisResult | null;
  };
}

describe("run lifecycle", () => {
  test("a live run streams to done and leaves a persisted completed row", async () => {
    const env = await createTestEnv();
    const runId = await startLive(env);
    const events = await readEvents(env, runId);

    expect(events[0]?.type).toBe("snapshot");
    expect(events.at(-1)).toEqual({ type: "done", status: "completed" });
    expect(events.some((e) => e.type === "result")).toBe(true);

    const run = await getRun(env, runId);
    expect(run.status).toBe("completed");
    expect(run.result?.schemaVersion).toBe(1);
    expect(run.result?.graph.edges.length).toBeGreaterThanOrEqual(3);
    expect(run.riskLevel).toBe(run.result?.riskLevel ?? null);

    const row = env.db.investigations.get(runId);
    expect(row?.status).toBe("completed");
    expect(row?.finishedAt).not.toBeNull();
  });

  test("late subscribers of a finished run get snapshot, result and done", async () => {
    const env = await createTestEnv();
    const runId = await startLive(env);
    await env.manager.waitForRun(runId);
    const events = await readEvents(env, runId);
    expect(events.map((e) => e.type)).toEqual(["snapshot", "result", "done"]);
  });

  test("snapshot on subscribe contains the edges added so far", async () => {
    const env = await createTestEnv({
      transport: fakeTransport(chainOfTransfers(8), { delayMs: 15 }),
    });
    const runId = await startLive(env, { maxDepth: 6 });
    const seen: string[] = [];
    const first = env.manager.subscribe(runId, (e) => {
      if (e.type === "edge_added") seen.push(e.edge.id);
    });
    while (seen.length < 2) await Bun.sleep(5);

    let snapshotIds: string[] = [];
    const second = env.manager.subscribe(runId, (e) => {
      if (e.type === "snapshot" && snapshotIds.length === 0) snapshotIds = e.edges.map((x) => x.id);
    });
    expect(snapshotIds.length).toBeGreaterThanOrEqual(2);
    for (const id of seen.slice(0, 2)) expect(snapshotIds).toContain(id);
    first?.();
    second?.();
    await env.manager.waitForRun(runId);
  });

  test("unknown runs 404 on every read endpoint", async () => {
    const env = await createTestEnv();
    for (const path of ["/api/runs/nope", "/api/runs/nope/events", "/api/runs/nope/export.json"]) {
      const res = await env.app.request(path);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
  });
});

describe("request validation", () => {
  test("rejects a malformed seed with 400 naming the field", async () => {
    const env = await createTestEnv();
    const res = await env.app.request(
      ...post("/api/runs", liveBody({ seeds: [{ kind: "tx", value: "nope" }] })),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("seeds.0.value");
  });

  test("seed values are validated per chain", async () => {
    const env = await createTestEnv();
    const tronAddress = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const res = await env.app.request(
      ...post("/api/runs", liveBody({ seeds: [{ kind: "address", value: tronAddress }] })),
    );
    expect(res.status).toBe(400);
  });

  test("rejects out-of-range limits and malformed JSON", async () => {
    const env = await createTestEnv();
    expect((await env.app.request(...post("/api/runs", liveBody({ maxDepth: 99 })))).status).toBe(
      400,
    );
    const bad = await env.app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: unknown }).error).toBeDefined();
  });

  test("a chain without a key returns 409 chain_not_ready", async () => {
    const env = await createTestEnv({ env: { ETHERSCAN_API_KEY: "" } });
    const res = await env.app.request(...post("/api/runs", liveBody()));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("chain_not_ready");
  });

  test("more than the allowed number of live runs returns 429", async () => {
    const env = await createTestEnv({
      transport: fakeTransport(chainOfTransfers(8), { delayMs: 30 }),
      maxLiveRuns: 1,
    });
    const first = await startLive(env);
    const res = await env.app.request(...post("/api/runs", liveBody()));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("too_many_runs");
    env.manager.cancel(first);
    await env.manager.waitForRun(first);
  });
});

describe("demo mode", () => {
  test("DEMO_ONLY rejects live runs while recorded demos replay without keys", async () => {
    const recorder = await createTestEnv();
    const demoId = await recordDemoScenario(recorder.runtime, recorder.fixturesDir);

    const env = await createTestEnv({
      env: { ETHERSCAN_API_KEY: "", DEMO_ONLY: "true" },
      fixturesDir: recorder.fixturesDir,
      // Replay must never touch the network: a live transport would fail the test.
      transport: async () => {
        throw new Error("network used");
      },
    });
    const health = (await (await env.app.request("/api/health")).json()) as {
      chains: Record<string, string>;
      demoOnly: boolean;
    };
    expect(health.demoOnly).toBe(true);
    expect(health.chains.ethereum).toBe("missing_key");

    const live = await env.app.request(...post("/api/runs", liveBody()));
    expect(live.status).toBe(403);
    expect(((await live.json()) as { error: { code: string } }).error.code).toBe("demo_only");

    const list = (await (await env.app.request("/api/demo")).json()) as { id: string }[];
    expect(list.map((d) => d.id)).toEqual([demoId]);

    const res = await env.app.request(...post("/api/runs", { demo: demoId }));
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    const events = await readEvents(env, runId);
    expect(events.at(-1)).toEqual({ type: "done", status: "completed" });
    const run = await getRun(env, runId);
    expect(run.result?.graph.edges.length).toBeGreaterThanOrEqual(3);
    expect(env.db.investigations.get(runId)?.demo).toBe(demoId);

    const unknown = await env.app.request(...post("/api/runs", { demo: "missing" }));
    expect(unknown.status).toBe(404);
  });

  test("a demo replay matches its recording", async () => {
    const env = await createTestEnv();
    const demoId = await recordDemoScenario(env.runtime, env.fixturesDir);
    const { runId } = (await (
      await env.app.request(...post("/api/runs", { demo: demoId }))
    ).json()) as { runId: string };
    await env.manager.waitForRun(runId);
    const replay = await getRun(env, runId);
    expect(replay.status).toBe("completed");
    expect(replay.result?.stats.apiCalls).toBeGreaterThan(0);
  });
});

describe("expand", () => {
  test("continues a max_depth edge and merges the new edges into the persisted result", async () => {
    const env = await createTestEnv();
    const runId = await startLive(env, { maxDepth: 2 });
    await env.manager.waitForRun(runId);
    const before = (await getRun(env, runId)).result as AnalysisResult;
    const stopped = before.graph.edges.find((e) => e.stopReason === "max_depth");
    expect(stopped).toBeDefined();

    const res = await env.app.request(
      ...post(`/api/runs/${runId}/expand`, { edgeId: stopped?.id, maxDepth: 2 }),
    );
    expect(res.status).toBe(202);
    expect(env.db.investigations.get(runId)?.status).toBe("running");
    await env.manager.waitForRun(runId);

    const after = (await getRun(env, runId)).result as AnalysisResult;
    expect(after.status).toBe("completed");
    expect(after.graph.edges.length).toBeGreaterThan(before.graph.edges.length);
    expect(after.graph.edges.find((e) => e.id === stopped?.id)?.status).toBe("expanded");
    for (const e of before.graph.edges) {
      expect(after.graph.edges.some((x) => x.id === e.id)).toBe(true);
    }
    expect(after.stats.apiCalls).toBeGreaterThanOrEqual(before.stats.apiCalls);
    expect(after.stats.maxDepthReached).toBeGreaterThan(before.stats.maxDepthReached);
  });

  test("refuses edges that are not stopped for an expandable reason", async () => {
    const env = await createTestEnv();
    const runId = await startLive(env, { maxDepth: 2 });
    await env.manager.waitForRun(runId);
    const result = (await getRun(env, runId)).result as AnalysisResult;
    const expanded = result.graph.edges.find((e) => e.status === "expanded");

    const res = await env.app.request(
      ...post(`/api/runs/${runId}/expand`, { edgeId: expanded?.id }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "edge_not_expandable",
    );

    const missing = await env.app.request(...post(`/api/runs/${runId}/expand`, { edgeId: "nope" }));
    expect(missing.status).toBe(404);
  });

  test("is unavailable on DEMO_ONLY instances", async () => {
    const env = await createTestEnv({ env: { DEMO_ONLY: "true" } });
    const demoId = await recordDemoScenario(env.runtime, env.fixturesDir);
    const { runId } = (await (
      await env.app.request(...post("/api/runs", { demo: demoId }))
    ).json()) as { runId: string };
    await env.manager.waitForRun(runId);
    const result = (await getRun(env, runId)).result as AnalysisResult;
    const stopped = result.graph.edges.find((e) => e.status === "stopped");
    const res = await env.app.request(
      ...post(`/api/runs/${runId}/expand`, { edgeId: stopped?.id }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("demo_only");
  });
});

describe("pause, resume and cancel", () => {
  test("are idempotent and cancel persists a cancelled run", async () => {
    const env = await createTestEnv({
      transport: fakeTransport(chainOfTransfers(8), { delayMs: 20 }),
    });
    const runId = await startLive(env, { maxDepth: 6 });
    const statuses: string[] = [];
    env.manager.subscribe(runId, (e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    expect(env.manager.pause(runId).status).toBe("paused");
    expect(env.manager.pause(runId).status).toBe("paused");
    expect(
      ((await (await env.app.request(`/api/runs/${runId}`)).json()) as { status: string }).status,
    ).toBe("paused");
    expect(env.manager.resume(runId).status).toBe("running");
    expect(env.manager.resume(runId).status).toBe("running");
    expect(statuses).toEqual(["paused", "running"]);

    env.manager.cancel(runId);
    env.manager.cancel(runId);
    await env.manager.waitForRun(runId);
    expect(env.db.investigations.get(runId)?.status).toBe("cancelled");

    // Controls on a finished run are no-ops that report the final status.
    expect(env.manager.pause(runId).status).toBe("cancelled");
    expect(env.manager.resume(runId).status).toBe("cancelled");
    expect(env.manager.cancel(runId).status).toBe("cancelled");
    const res = await env.app.request(`/api/runs/${runId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await env.app.request("/api/runs/nope/pause", { method: "POST" })).status).toBe(404);
  });

  test("a paused run makes no progress until resumed", async () => {
    let calls = 0;
    const env = await createTestEnv({
      transport: fakeTransport(chainOfTransfers(8), { delayMs: 10, onRequest: () => calls++ }),
    });
    const runId = await startLive(env, { maxDepth: 6 });
    env.manager.pause(runId);
    await Bun.sleep(100); // let in-flight requests drain
    const frozen = calls;
    await Bun.sleep(150);
    expect(calls).toBe(frozen);
    env.manager.resume(runId);
    await env.manager.waitForRun(runId);
    expect(calls).toBeGreaterThan(frozen);
    expect(env.db.investigations.get(runId)?.status).toBe("completed");
  });
});

describe("history", () => {
  function seed(env: TestEnv) {
    const base = {
      seeds: [{ id: "s1" as const, kind: "tx" as const, value: txHash(9) }],
      params: {} as never,
    };
    const rows = [
      { id: "a", chain: "ethereum", status: "completed", title: "Alpha case", at: "2026-01-01" },
      { id: "b", chain: "tron", status: "failed", title: "Bravo", at: "2026-01-02" },
      { id: "c", chain: "ethereum", status: "cancelled", title: "Charlie", at: "2026-01-03" },
      { id: "d", chain: "polygon", status: "completed", title: "Delta", at: "2026-01-04" },
      { id: "e", chain: "ethereum", status: "completed", title: "Echo", at: "2026-01-05" },
    ] as const;
    for (const r of rows) {
      env.db.investigations.insert({
        id: r.id,
        chain: r.chain,
        direction: "backward",
        ...base,
        status: r.status,
        title: r.title,
        demo: null,
        createdAt: `${r.at}T00:00:00.000Z`,
      });
    }
  }
  const ids = async (env: TestEnv, qs: string) => {
    const body = (await (await env.app.request(`/api/runs?${qs}`)).json()) as {
      items: { id: string; result?: unknown }[];
      total: number;
      totalAll: number;
    };
    return {
      ids: body.items.map((i) => i.id),
      total: body.total,
      totalAll: body.totalAll,
      items: body.items,
    };
  };

  test("paginates newest first without result payloads", async () => {
    const env = await createTestEnv();
    seed(env);
    const page1 = await ids(env, "limit=2");
    expect(page1.ids).toEqual(["e", "d"]);
    expect(page1.total).toBe(5);
    expect(page1.items.every((i) => !("result" in i))).toBe(true);
    expect((await ids(env, "limit=2&offset=2")).ids).toEqual(["c", "b"]);
    expect((await ids(env, "limit=2&offset=4")).ids).toEqual(["a"]);
  });

  test("filters by chain, status and free text", async () => {
    const env = await createTestEnv();
    seed(env);
    expect((await ids(env, "chain=ethereum")).ids).toEqual(["e", "c", "a"]);
    expect((await ids(env, "status=completed")).total).toBe(3);
    expect((await ids(env, "chain=ethereum&status=completed")).ids).toEqual(["e", "a"]);
    expect((await ids(env, "q=brav")).ids).toEqual(["b"]);
    expect((await ids(env, "q=%25")).total).toBe(0);
    expect((await ids(env, "chain=ethereum")).totalAll).toBe(5);
  });

  test("rejects bad query params", async () => {
    const env = await createTestEnv();
    expect((await env.app.request("/api/runs?limit=0")).status).toBe(400);
    expect((await env.app.request("/api/runs?limit=101")).status).toBe(400);
    expect((await env.app.request("/api/runs?chain=btc")).status).toBe(400);
  });

  test("patch edits title and notes; delete removes finished runs only", async () => {
    const env = await createTestEnv({
      transport: fakeTransport(chainOfTransfers(8), { delayMs: 20 }),
    });
    const runId = await startLive(env, { maxDepth: 6 });

    const busy = await env.app.request(`/api/runs/${runId}`, { method: "DELETE" });
    expect(busy.status).toBe(409);

    env.manager.cancel(runId);
    await env.manager.waitForRun(runId);

    const patched = await env.app.request(`/api/runs/${runId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed", notes: "checked by A" }),
    });
    expect(patched.status).toBe(200);
    const row = (await patched.json()) as { title: string; notes: string };
    expect(row).toMatchObject({ title: "Renamed", notes: "checked by A" });

    expect((await env.app.request(`/api/runs/${runId}`, { method: "DELETE" })).status).toBe(200);
    expect((await env.app.request(`/api/runs/${runId}`)).status).toBe(404);
  });
});

describe("exports and screening", () => {
  test("serves JSON and CSV exports and rejects unknown kinds", async () => {
    const env = await createTestEnv();
    const runId = await startLive(env);
    await env.manager.waitForRun(runId);

    const json = (await (
      await env.app.request(`/api/runs/${runId}/export.json`)
    ).json()) as AnalysisResult;
    expect(json.runId).toBe(runId);

    const csv = await env.app.request(`/api/runs/${runId}/export.csv?kind=edges`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.startsWith("\uFEFFdepth,from,")).toBe(true);
    expect(text.split("\r\n").length).toBeGreaterThan(3);

    expect((await env.app.request(`/api/runs/${runId}/export.csv?kind=nope`)).status).toBe(400);
  });

  test("screens an address against bundled labels without explorer calls", async () => {
    let calls = 0;
    const env = await createTestEnv({
      transport: async (req) => {
        calls++;
        return fakeTransport([])(req);
      },
    });
    const baseline = calls; // boot-time OFAC fetch
    const binance = "0x28c6c06298d514db089934071355e5743bf21d60";
    const res = await env.app.request(`/api/screen/ethereum/${binance}`);
    const body = (await res.json()) as { labels: { category: string }[]; sanctioned: boolean };
    expect(body.labels.some((l) => l.category === "exchange")).toBe(true);
    expect(body.sanctioned).toBe(false);
    expect(calls).toBe(baseline);
    expect((await env.app.request("/api/screen/ethereum/0x123")).status).toBe(400);
    expect((await env.app.request("/api/screen/btc/0x123")).status).toBe(400);
  });

  test("health reports chain readiness, version and label data", async () => {
    const env = await createTestEnv({ env: { TRONSCAN_API_KEYS: "k1, k2" } });
    const h = (await (await env.app.request("/api/health")).json()) as Record<string, unknown>;
    expect(h.chains).toEqual({
      ethereum: "ready",
      polygon: "ready",
      arbitrum: "ready",
      tron: "ready",
    });
    expect(h.demoOnly).toBe(false);
    expect(typeof h.version).toBe("string");
    expect(h.labelsVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("unknown API paths return the JSON error envelope", async () => {
    const env = await createTestEnv();
    const res = await env.app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});
