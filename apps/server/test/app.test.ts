import { describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  type AnalysisResult,
  type CancelReason,
  EXPANDABLE_REASONS,
  RunController,
  type RunEvent,
  type RunParams,
  type Transport,
} from "@fot/core";
import {
  createApp,
  DEFAULT_EXPAND_DEPTH,
  DEFAULT_FIXTURES_DIR,
  executeRun,
  RunManager,
} from "../src/index.ts";
import {
  createTestEnv,
  LIVE_SEED_TX,
  liveBody,
  post,
  recordDemoScenario,
  type TestEnv,
  tempDir,
} from "./helpers/env.ts";
import {
  addr,
  chainOfTransfers,
  fakeTransport,
  T0,
  twoBranches,
  txHash,
} from "./helpers/fake-etherscan.ts";

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

/**
 * Stores a finished live run whose trace was stopped with `reason` as soon as the seed edge had
 * created its children, so every child carries the matching stop reason (`timeout` / `cancelled`).
 * `timeoutSec` cannot go below 10 s, so the stop is triggered on the controller instead.
 */
async function storeStoppedRun(env: TestEnv, reason: CancelReason): Promise<string> {
  const params: RunParams = {
    chain: "ethereum",
    direction: "backward",
    seeds: [{ id: "s1", kind: "tx", value: LIVE_SEED_TX }],
    maxDepth: 20,
    maxBranches: 3,
    maxEdges: 50,
    minUsd: 0,
    traceThroughEntities: false,
    followUnpriced: false,
    timeoutSec: 600,
  };
  const runId = crypto.randomUUID();
  env.db.investigations.insert({
    id: runId,
    chain: params.chain,
    direction: params.direction,
    seeds: params.seeds,
    params,
    status: "running",
    title: "Stopped run",
    demo: null,
    createdAt: new Date().toISOString(),
  });
  const controller = new RunController();
  let added = 0;
  const result = await executeRun({
    params,
    runtime: env.runtime,
    controller,
    runId,
    emit: (event) => {
      if (event.type === "edge_added" && ++added === 3) controller.cancel(reason);
    },
  });
  env.db.investigations.update(runId, {
    status: result.status,
    riskLevel: result.riskLevel,
    finishedAt: result.finishedAt,
    result,
  });
  return runId;
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

  test("the convergence follow-up stops when the run's time budget runs out", async () => {
    // a104 funds a102 and a103, which both fund a101: a104 is a linked wallet (convergence).
    const hour = 3600;
    const explorer = fakeTransport([
      { tx: 1, from: 101, to: 100, amount: 1000, ts: T0 + 5 * hour },
      { tx: 2, from: 102, to: 101, amount: 500, ts: T0 + 4 * hour },
      { tx: 3, from: 103, to: 101, amount: 500, ts: T0 + 4 * hour },
      { tx: 4, from: 104, to: 102, amount: 500, ts: T0 + 3 * hour },
      { tx: 5, from: 104, to: 103, amount: 500, ts: T0 + 3 * hour },
    ]);
    // Trace listings of an address carry a block range; the follow-up listing does not, and never
    // answers.
    const transport: Transport = (req) => {
      const q = new URL(req.url).searchParams;
      if (!q.has("address") || q.has("startblock") || q.has("endblock")) return explorer(req);
      const { promise, reject } = Promise.withResolvers<never>();
      req.signal?.addEventListener("abort", () => reject(req.signal?.reason), { once: true });
      return promise;
    };
    const env = await createTestEnv({ transport });
    const params: RunParams = {
      chain: "ethereum",
      direction: "backward",
      seeds: [{ id: "s1", kind: "tx", value: LIVE_SEED_TX }],
      maxDepth: 5,
      maxBranches: 3,
      maxEdges: 50,
      minUsd: 0,
      traceThroughEntities: false,
      followUnpriced: false,
      // Below the API minimum (10 s) to keep the test short; the trace itself needs well under 1 s.
      timeoutSec: 2,
    };
    const started = performance.now();
    const result = await executeRun({
      params,
      runtime: env.runtime,
      controller: new RunController(),
      runId: crypto.randomUUID(),
      emit: () => {},
    });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(result.status).toBe("completed");
    expect(result.convergences.map((c) => c.address)).toEqual([addr(104)]);
    expect(result.warnings.map((w) => w.code)).toContain("convergence_followup_failed");
  }, 10_000);

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

    const list = (await (await env.app.request("/api/demo")).json()) as {
      id: string;
      addresses?: number;
      transfers?: number;
    }[];
    expect(list.map((d) => d.id)).toEqual([demoId]);
    // recordDemoScenario writes no counts, like scenarios recorded before counts existed.
    expect(list[0]).not.toHaveProperty("addresses");
    expect(list[0]).not.toHaveProperty("transfers");

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

  test("committed demo scenarios carry the address and transfer counts of their replay", async () => {
    const env = await createTestEnv({
      fixturesDir: DEFAULT_FIXTURES_DIR,
      transport: async () => {
        throw new Error("network used");
      },
    });
    const list = (await (await env.app.request("/api/demo")).json()) as {
      id: string;
      addresses?: number;
      transfers?: number;
    }[];
    expect(list.length).toBeGreaterThan(0);
    for (const demo of list) {
      const { runId } = (await (
        await env.app.request(...post("/api/runs", { demo: demo.id }))
      ).json()) as { runId: string };
      await env.manager.waitForRun(runId);
      const { status, result } = await getRun(env, runId);
      expect(status).toBe("completed");
      expect({ id: demo.id, addresses: demo.addresses, transfers: demo.transfers }).toEqual({
        id: demo.id,
        addresses: result?.graph.addresses.length,
        transfers: result?.graph.edges.length,
      });
    }
  });

  test("DEMO_ONLY refuses edits, deletes and run controls before looking the run up", async () => {
    const env = await createTestEnv({ env: { DEMO_ONLY: "true" } });
    const demoId = await recordDemoScenario(env.runtime, env.fixturesDir);
    const { runId } = (await (
      await env.app.request(...post("/api/runs", { demo: demoId }))
    ).json()) as { runId: string };
    const expectDemoOnly = async (res: Response) => {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("demo_only");
    };

    for (const action of ["pause", "resume", "cancel"]) {
      await expectDemoOnly(
        await env.app.request(`/api/runs/${runId}/${action}`, { method: "POST" }),
      );
    }
    await env.manager.waitForRun(runId);
    expect((await getRun(env, runId)).status).toBe("completed");

    const before = env.db.investigations.get(runId);
    await expectDemoOnly(
      await env.app.request(`/api/runs/${runId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "defaced", notes: "x" }),
      }),
    );
    const after = env.db.investigations.get(runId);
    expect({ title: after?.title, notes: after?.notes }).toEqual({
      title: before?.title,
      notes: before?.notes,
    });

    await expectDemoOnly(await env.app.request(`/api/runs/${runId}`, { method: "DELETE" }));
    expect((await env.app.request(`/api/runs/${runId}`)).status).toBe(200);
    // Refused before the lookup: an unknown id gets the same answer, so ids cannot be probed.
    await expectDemoOnly(
      await env.app.request(`/api/runs/${crypto.randomUUID()}`, { method: "DELETE" }),
    );
  });

  test("DEMO_ONLY lists and serves only demo investigations", async () => {
    const env = await createTestEnv({ env: { DEMO_ONLY: "true" } });
    const demoId = await recordDemoScenario(env.runtime, env.fixturesDir);
    const { runId: demoRun } = (await (
      await env.app.request(...post("/api/runs", { demo: demoId }))
    ).json()) as { runId: string };
    await env.manager.waitForRun(demoRun);
    const result = env.db.investigations.getResult(demoRun) as AnalysisResult;

    // A live investigation left in DATA_DIR before the instance went demo-only.
    const liveId = crypto.randomUUID();
    env.db.investigations.insert({
      id: liveId,
      chain: result.chain,
      direction: result.params.direction,
      seeds: result.params.seeds,
      params: result.params,
      status: "running",
      title: "Private live case",
      demo: null,
      createdAt: new Date().toISOString(),
    });
    env.db.investigations.update(liveId, {
      status: "completed",
      riskLevel: result.riskLevel,
      finishedAt: result.finishedAt,
      result,
    });

    const list = (await (await env.app.request("/api/runs")).json()) as {
      items: { id: string }[];
      total: number;
      totalAll: number;
    };
    expect({
      ids: list.items.map((i) => i.id),
      total: list.total,
      totalAll: list.totalAll,
    }).toEqual({ ids: [demoRun], total: 1, totalAll: 1 });
    const search = (await (await env.app.request("/api/runs?q=Private")).json()) as {
      total: number;
    };
    expect(search.total).toBe(0);

    for (const path of ["", "/events", "/export.json", "/export.csv"]) {
      expect((await env.app.request(`/api/runs/${liveId}${path}`)).status).toBe(404);
    }
    const expand = await env.app.request(...post(`/api/runs/${liveId}/expand`, { edgeId: "any" }));
    expect(expand.status).toBe(404);
    expect(((await expand.json()) as { error: { code: string } }).error.code).toBe("not_found");

    expect((await env.app.request(`/api/runs/${demoRun}`)).status).toBe(200);
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

  test("refuses recorded demo runs and leaves the stored result untouched", async () => {
    const env = await createTestEnv();
    const demoId = await recordDemoScenario(env.runtime, env.fixturesDir);
    const { runId } = (await (
      await env.app.request(...post("/api/runs", { demo: demoId }))
    ).json()) as { runId: string };
    await env.manager.waitForRun(runId);
    const before = (await getRun(env, runId)).result as AnalysisResult;
    const stopped = before.graph.edges.find(
      (e) => e.stopReason !== null && EXPANDABLE_REASONS.has(e.stopReason),
    );
    expect(stopped).toBeDefined();

    const res = await env.app.request(
      ...post(`/api/runs/${runId}/expand`, { edgeId: stopped?.id }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "demo_run_not_expandable",
    );
    const after = await getRun(env, runId);
    expect(after.status).toBe("completed");
    expect(after.result).toEqual(before);
  });

  test("a cancelled expansion keeps the completed status and the edges it found", async () => {
    const env = await createTestEnv({ transport: fakeTransport(chainOfTransfers(12)) });
    const runId = await startLive(env, { maxDepth: 2 });
    await env.manager.waitForRun(runId);
    const before = (await getRun(env, runId)).result as AnalysisResult;
    const stopped = before.graph.edges.find((e) => e.stopReason === "max_depth");
    if (!stopped) throw new Error("expected a max_depth edge");

    // Called on the manager so the subscription is in place before the continuation's first
    // edge: it cancels the expansion as soon as that edge arrives.
    const expanding = env.manager.expand(runId, stopped.id, { maxDepth: 10 });
    env.manager.subscribe(runId, (e) => {
      if (e.type === "edge_added") env.manager.cancel(runId);
    });
    await expanding;
    await env.manager.waitForRun(runId);

    const after = await getRun(env, runId);
    expect(after.status).toBe("completed");
    expect(after.result?.status).toBe("completed");
    expect(after.result?.graph.edges.length).toBeGreaterThan(before.graph.edges.length);
    expect(after.result?.graph.edges.some((e) => e.stopReason === "cancelled")).toBe(true);
  });

  test("an expansion interrupted by a restart ends failed, without the previous result", async () => {
    const env = await createTestEnv({
      transport: fakeTransport(chainOfTransfers(12), { delayMs: 20 }),
    });
    const runId = await startLive(env, { maxDepth: 2 });
    await env.manager.waitForRun(runId);
    const before = (await getRun(env, runId)).result as AnalysisResult;
    const stopped = before.graph.edges.find((e) => e.stopReason === "max_depth");
    if (!stopped) throw new Error("expected a max_depth edge");
    const res = await env.app.request(
      ...post(`/api/runs/${runId}/expand`, { edgeId: stopped.id, maxDepth: 2 }),
    );
    expect(res.status).toBe(202);

    // The process dies mid-expansion; the next boot recovers the row and serves it.
    expect(env.db.investigations.markInterrupted()).toBe(1);
    const rebooted = new RunManager({ runtime: env.runtime, db: env.db, replayDelayMs: 0 });
    const events: RunEvent[] = [];
    rebooted.subscribe(runId, (e) => events.push(e));
    expect(events).toEqual([
      { type: "snapshot", status: "failed", edges: [], stats: {} },
      { type: "error", code: "interrupted", message: expect.any(String) },
      { type: "done", status: "failed" },
    ]);
    expect(rebooted.get(runId)).toMatchObject({ status: "interrupted", result: null });

    env.manager.cancel(runId);
    await env.manager.waitForRun(runId);
  });

  test("an expansion that throws ends failed, without the previous result", async () => {
    const env = await createTestEnv();
    const runId = await startLive(env, { maxDepth: 2 });
    await env.manager.waitForRun(runId);
    const before = (await getRun(env, runId)).result as AnalysisResult;
    const stopped = before.graph.edges.find((e) => e.stopReason === "max_depth");
    if (!stopped) throw new Error("expected a max_depth edge");
    env.runtime.explorerFor = () => {
      throw new Error("explorer exploded");
    };

    // Called on the manager so the subscription is in place before the expansion fails.
    const expanding = env.manager.expand(runId, stopped.id, { maxDepth: 2 });
    const live: RunEvent[] = [];
    env.manager.subscribe(runId, (e) => live.push(e));
    await expanding;
    await env.manager.waitForRun(runId);

    expect(live.slice(-2)).toEqual([
      { type: "error", code: "run_failed", message: "explorer exploded" },
      { type: "done", status: "failed" },
    ]);
    const after = await getRun(env, runId);
    expect(after).toMatchObject({ status: "failed", riskLevel: null, result: null });
    const replay = await readEvents(env, runId);
    expect(replay.map((e) => e.type)).toEqual(["snapshot", "error", "done"]);
    expect(replay.at(-1)).toEqual({ type: "done", status: "failed" });
  });

  test.each([
    ["timed_out", "timeout"],
    ["cancelled", "cancelled"],
  ] as const)("a %s run keeps that status until no %s edge is left", async (status, reason) => {
    const env = await createTestEnv({ transport: fakeTransport(twoBranches(4)) });
    const runId = await storeStoppedRun(env, reason);
    const before = (await getRun(env, runId)).result as AnalysisResult;
    expect(before.status).toBe(status);
    const open = before.graph.edges.filter((e) => e.stopReason === reason).map((e) => e.id);
    expect(open).toHaveLength(2);

    for (const [index, edgeId] of open.entries()) {
      const res = await env.app.request(
        ...post(`/api/runs/${runId}/expand`, { edgeId, maxDepth: 1 }),
      );
      expect(res.status).toBe(202);
      await env.manager.waitForRun(runId);
      const run = await getRun(env, runId);
      const expected = index === 0 ? status : "completed";
      expect(run.status).toBe(expected);
      expect(run.result?.status).toBe(expected);
    }
  });

  test("an expansion streams its edge and base first, then run totals that never go backwards", async () => {
    const env = await createTestEnv({ transport: fakeTransport(chainOfTransfers(12)) });
    const runId = await startLive(env, { maxDepth: 2 });
    await env.manager.waitForRun(runId);
    const before = (await getRun(env, runId)).result as AnalysisResult;
    const stopped = before.graph.edges.find((e) => e.stopReason === "max_depth");
    if (!stopped) throw new Error("expected a max_depth edge");

    // Called on the manager so the subscription is in place before the continuation's first edge.
    const expanding = env.manager.expand(runId, stopped.id, { maxDepth: 2 });
    const events: RunEvent[] = [];
    env.manager.subscribe(runId, (e) => events.push(e));
    await expanding;
    await env.manager.waitForRun(runId);

    expect(events.slice(0, 3).map((e) => e.type)).toEqual(["snapshot", "expansion", "provisional"]);
    const { expandedEdges, apiCalls, cacheHits } = before.stats;
    expect(events[1]).toEqual({
      type: "expansion",
      edgeId: stopped.id,
      maxDepth: 2,
      base: { expandedEdges, apiCalls, cacheHits },
    });
    const progress = events.flatMap((e) => (e.type === "progress" ? [e] : []));
    for (const p of progress) {
      expect(p.expandedEdges).toBeGreaterThanOrEqual(expandedEdges);
      expect(p.apiCalls).toBeGreaterThanOrEqual(apiCalls);
    }
    const after = (await getRun(env, runId)).result as AnalysisResult;
    const last = progress.at(-1);
    expect({ expandedEdges: last?.expandedEdges, apiCalls: last?.apiCalls }).toEqual({
      expandedEdges: after.stats.expandedEdges,
      apiCalls: after.stats.apiCalls,
    });
  });

  test("the API still continues DEFAULT_EXPAND_DEPTH hops when maxDepth is omitted", async () => {
    const env = await createTestEnv({ transport: fakeTransport(chainOfTransfers(12)) });
    const runId = await startLive(env, { maxDepth: 2 });
    await env.manager.waitForRun(runId);
    const before = (await getRun(env, runId)).result as AnalysisResult;
    const stopped = before.graph.edges.find((e) => e.stopReason === "max_depth");
    if (!stopped) throw new Error("expected a max_depth edge");

    const res = await env.app.request(...post(`/api/runs/${runId}/expand`, { edgeId: stopped.id }));
    expect(res.status).toBe(202);
    await env.manager.waitForRun(runId);
    const after = (await getRun(env, runId)).result as AnalysisResult;
    expect(after.stats.maxDepthReached).toBe(stopped.depth + DEFAULT_EXPAND_DEPTH);
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

describe("provisional analysis", () => {
  test("streams before the result, never after it, and is never stored", async () => {
    // Real timers on purpose: this exercises the provisional interval against the transport delay.
    const env = await createTestEnv({
      transport: fakeTransport(chainOfTransfers(8), { delayMs: 15 }),
      provisionalIntervalMs: 5,
    });
    const runId = await startLive(env, { maxDepth: 6 });
    const types: string[] = [];
    // What the database held each time a provisional analysis was streamed.
    const stored: { riskLevel: string | null; result: AnalysisResult | null }[] = [];
    const results: AnalysisResult[] = [];
    env.manager.subscribe(runId, (e) => {
      types.push(e.type);
      if (e.type === "provisional") {
        stored.push({
          riskLevel: env.db.investigations.get(runId)?.riskLevel ?? null,
          result: env.db.investigations.getResult(runId),
        });
      }
      if (e.type === "result") results.push(e.result);
    });
    await env.manager.waitForRun(runId);

    const resultAt = types.indexOf("result");
    expect(types.slice(0, resultAt)).toContain("provisional");
    expect(types.slice(resultAt)).not.toContain("provisional");
    expect(new Set(stored.map((s) => JSON.stringify(s)))).toEqual(
      new Set([JSON.stringify({ riskLevel: null, result: null })]),
    );
    expect((await getRun(env, runId)).result).toEqual(results[0] ?? null);
  });

  test("pausing streams it at once and late subscribers get it after the snapshot", async () => {
    const env = await createTestEnv({
      transport: fakeTransport(chainOfTransfers(8), { delayMs: 20 }),
    });
    const runId = await startLive(env, { maxDepth: 6 });
    const events: RunEvent[] = [];
    const firstEdge = Promise.withResolvers<void>();
    env.manager.subscribe(runId, (e) => {
      events.push(e);
      if (e.type === "edge_added") firstEdge.resolve();
    });
    await firstEdge.promise;

    env.manager.pause(runId);
    expect(events.slice(-2).map((e) => e.type)).toEqual(["status", "provisional"]);

    const late: RunEvent[] = [];
    env.manager.subscribe(runId, (e) => late.push(e));
    const [snapshot, provisional] = late;
    expect(late.map((e) => e.type)).toEqual(["snapshot", "provisional"]);
    expect(provisional).toEqual(events.at(-1));
    if (snapshot?.type !== "snapshot" || provisional?.type !== "provisional") return;
    const analyzed = new Set(provisional.analysis.graph.addresses.map((a) => a.address));
    for (const edge of snapshot.edges) {
      expect(analyzed.has(edge.far) && analyzed.has(edge.near)).toBe(true);
    }

    env.manager.resume(runId);
    await env.manager.waitForRun(runId);
  });

  test("an expansion's first subscriber gets the merged graph's analysis with the snapshot", async () => {
    const env = await createTestEnv({ transport: fakeTransport(chainOfTransfers(12)) });
    const runId = await startLive(env, { maxDepth: 2 });
    await env.manager.waitForRun(runId);
    const before = (await getRun(env, runId)).result as AnalysisResult;
    const stopped = before.graph.edges.find((e) => e.stopReason === "max_depth");
    if (!stopped) throw new Error("expected a max_depth edge");

    // Called on the manager so the subscription is in place before the continuation's first edge.
    const expanding = env.manager.expand(runId, stopped.id, { maxDepth: 2 });
    // Everything the subscriber gets before the continuation's first new edge.
    const upfront: RunEvent[] = [];
    let streaming = false;
    env.manager.subscribe(runId, (e) => {
      if (e.type === "edge_added") streaming = true;
      if (!streaming) upfront.push(e);
    });
    await expanding;
    await env.manager.waitForRun(runId);

    const provisional = upfront.find((e) => e.type === "provisional");
    if (provisional?.type !== "provisional") throw new Error("no provisional analysis up front");
    expect(provisional.analysis.graph.addresses.map((a) => a.address).sort()).toEqual(
      before.graph.addresses.map((a) => a.address).sort(),
    );
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
    const body = (await res.json()) as {
      labels: { category: string }[];
      sanctioned: boolean;
      ofac: { available: boolean; fetchedAt: string | null };
    };
    expect(body.labels.some((l) => l.category === "exchange")).toBe(true);
    expect(body.sanctioned).toBe(false);
    expect(typeof env.runtime.ofacFetchedAt).toBe("string");
    expect(body.ofac).toEqual({ available: true, fetchedAt: env.runtime.ofacFetchedAt });
    const listed = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const sdn = (await (await env.app.request(`/api/screen/ethereum/${listed}`)).json()) as {
      sanctioned: boolean;
    };
    expect(sdn.sanctioned).toBe(true);
    expect(calls).toBe(baseline);
    expect((await env.app.request("/api/screen/ethereum/0x123")).status).toBe(400);
    expect((await env.app.request("/api/screen/btc/0x123")).status).toBe(400);
  });

  test("marks the OFAC list unavailable when screening without it", async () => {
    const env = await createTestEnv({ transport: async () => ({ status: 503, body: "down" }) });
    const listed = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const body = (await (await env.app.request(`/api/screen/ethereum/${listed}`)).json()) as {
      sanctioned: boolean;
      ofac: { available: boolean; fetchedAt: string | null };
    };
    expect(body.ofac).toEqual({ available: false, fetchedAt: null });
    expect(body.sanctioned).toBe(false);
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

describe("resource limits", () => {
  const codeOf = async (res: Response) =>
    ((await res.json()) as { error: { code: string } }).error.code;

  async function replayToEnd(env: TestEnv, demoId: string): Promise<string> {
    const res = await env.app.request(...post("/api/runs", { demo: demoId }));
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    await env.manager.waitForRun(runId);
    return runId;
  }

  test("demo replays are capped, exactly under concurrency, and a freed slot admits the next", async () => {
    const env = await createTestEnv({ maxDemoRuns: 2, replayDelayMs: 50 });
    const demoId = await recordDemoScenario(env.runtime, env.fixturesDir);
    const startDemo = () => env.app.request(...post("/api/runs", { demo: demoId }));

    const started = await Promise.all([startDemo(), startDemo(), startDemo()]);
    expect(started.map((r) => r.status).sort()).toEqual([201, 201, 429]);
    const refused = started.find((r) => r.status === 429) as Response;
    expect(await codeOf(refused)).toBe("too_many_runs");
    const ids = await Promise.all(
      started
        .filter((r) => r.status === 201)
        .map(async (r) => ((await r.json()) as { runId: string }).runId),
    );
    for (const id of ids) env.manager.pause(id);
    expect((await startDemo()).status).toBe(429);

    for (const id of ids) env.manager.cancel(id);
    await Promise.all(ids.map((id) => env.manager.waitForRun(id)));
    const next = await startDemo();
    expect(next.status).toBe(201);
    await env.manager.waitForRun(((await next.json()) as { runId: string }).runId);
  });

  test("a scenario recording is loaded once and shared by later replays", async () => {
    const env = await createTestEnv();
    const demoId = await recordDemoScenario(env.runtime, env.fixturesDir);
    const edgesOf = async (runId: string) => (await getRun(env, runId)).result?.graph.edges.length;
    const first = await edgesOf(await replayToEnd(env, demoId));
    expect(first).toBeGreaterThan(0);

    rmSync(join(env.fixturesDir, demoId, "http.json.gz"));
    rmSync(join(env.fixturesDir, demoId, "ofac.json"));
    expect(await edgesOf(await replayToEnd(env, demoId))).toBe(first);
  });

  test("DEMO_ONLY keeps only the newest demo runs; other instances keep them all", async () => {
    const listIds = async (env: TestEnv) => {
      const page = (await (await env.app.request("/api/runs")).json()) as {
        items: { id: string }[];
        totalAll: number;
      };
      return { ids: page.items.map((i) => i.id), totalAll: page.totalAll };
    };

    const demoOnly = await createTestEnv({ env: { DEMO_ONLY: "true" }, maxStoredDemoRuns: 2 });
    const demoId = await recordDemoScenario(demoOnly.runtime, demoOnly.fixturesDir);
    const [oldest, middle, newest] = [
      await replayToEnd(demoOnly, demoId),
      await replayToEnd(demoOnly, demoId),
      await replayToEnd(demoOnly, demoId),
    ];
    expect(await listIds(demoOnly)).toEqual({ ids: [newest, middle], totalAll: 2 });
    expect((await demoOnly.app.request(`/api/runs/${oldest}`)).status).toBe(404);

    const regular = await createTestEnv({ maxStoredDemoRuns: 2 });
    await recordDemoScenario(regular.runtime, regular.fixturesDir);
    for (let i = 0; i < 3; i++) await replayToEnd(regular, demoId);
    expect((await listIds(regular)).totalAll).toBe(3);
  });

  test("request bodies over the limit are refused before they are parsed", async () => {
    const env = await createTestEnv();
    const big = JSON.stringify({ ...liveBody(), padding: "x".repeat(200 * 1024) });
    const sized = await env.app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    });
    expect(sized.status).toBe(413);
    expect(await codeOf(sized)).toBe("payload_too_large");

    // Without a Content-Length the limit applies while the body is read.
    const bytes = new TextEncoder().encode(big);
    const chunked = await env.app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
    expect(chunked.status).toBe(413);
    expect(env.db.investigations.list().totalAll).toBe(0);

    // The largest legitimate body still fits: 20 000 three-byte characters of notes.
    const runId = await startLive(env);
    await env.manager.waitForRun(runId);
    const notes = "調".repeat(20_000);
    const patched = await env.app.request(`/api/runs/${runId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    expect(patched.status).toBe(200);
    expect(env.db.investigations.get(runId)?.notes).toBe(notes);
  });

  test("event streams are capped per run and in total, and a closed stream frees its slot", async () => {
    const env = await createTestEnv({
      transport: fakeTransport(chainOfTransfers(8), { delayMs: 20 }),
      streams: { total: 3, perRun: 2 },
    });
    const a = await startLive(env, { maxDepth: 6 });
    const b = await startLive(env, { maxDepth: 6 });
    env.manager.pause(a);
    env.manager.pause(b);
    const open = (runId: string) => env.app.request(`/api/runs/${runId}/events`);

    const streams = [await open(a), await open(a)];
    expect(streams.map((s) => s.status)).toEqual([200, 200]);
    const perRun = await open(a);
    expect(perRun.status).toBe(429);
    expect(await codeOf(perRun)).toBe("too_many_streams");
    streams.push(await open(b));
    expect(streams[2]?.status).toBe(200);
    const total = await open(b);
    expect(total.status).toBe(429);
    expect(await codeOf(total)).toBe("too_many_streams");

    await streams[0]?.body?.cancel();
    // The slot is released in the stream's `finally` once the cancel propagates: poll for it.
    let reopened = await open(b);
    for (let i = 0; i < 50 && reopened.status === 429; i++) {
      await Bun.sleep(10);
      reopened = await open(b);
    }
    expect(reopened.status).toBe(200);
    streams.push(reopened);

    for (const s of streams.slice(1)) await s.body?.cancel();
    for (const id of [a, b]) env.manager.cancel(id);
    await Promise.all([a, b].map((id) => env.manager.waitForRun(id)));
  });
});

describe("host check and security headers", () => {
  /** `Content-Security-Policy` as directive name → source list. */
  function cspOf(res: Response): Map<string, string> {
    const directives = new Map<string, string>();
    for (const part of (res.headers.get("content-security-policy") ?? "").split(";")) {
      const [name, ...sources] = part.trim().split(/\s+/);
      if (name) directives.set(name, sources.join(" "));
    }
    return directives;
  }

  test("requests for a host that is not allowed get 403 host_not_allowed on every route", async () => {
    const env = await createTestEnv();
    const responses = [
      await env.app.request("http://rebound.example:3000/api/health"),
      await env.app.request("http://rebound.example/"),
      await env.app.request(`http://rebound.example/api/runs/${crypto.randomUUID()}`, {
        method: "DELETE",
      }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "host_not_allowed",
      );
    }
  });

  test("loopback names and ALLOWED_HOSTS entries are served", async () => {
    const env = await createTestEnv();
    for (const url of [
      "http://localhost:3000/api/health",
      "http://LOCALHOST/api/health",
      "http://127.0.0.1:3000/api/health",
      "http://[::1]:3000/api/health",
    ]) {
      expect((await env.app.request(url)).status).toBe(200);
    }
    const listed = await createTestEnv({ env: { ALLOWED_HOSTS: "fot.example" } });
    expect((await listed.app.request("http://fot.example:8080/api/health")).status).toBe(200);
    expect((await listed.app.request("http://other.example/api/health")).status).toBe(403);
  });

  test("every response carries the security headers, refusals and the web app included", async () => {
    const env = await createTestEnv();
    const dir = tempDir();
    await Bun.write(join(dir, "index.html"), "<!doctype html><title>fot</title>");
    const web = createApp({ runtime: env.runtime, manager: env.manager, webDir: dir });
    const responses = [
      await env.app.request("/api/health"),
      await env.app.request("http://rebound.example/api/health"),
      await web.request("/"),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 403, 200]);
    for (const res of responses) {
      const csp = cspOf(res);
      expect(csp.get("script-src")).toBe("'self'");
      expect(csp.get("frame-ancestors")).toBe("'none'");
      expect(csp.get("object-src")).toBe("'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("strict-transport-security")).toBeNull();
    }
  });
});

describe("web app", () => {
  test("a malformed path is 400 and a missing build file 404; app routes fall back to index.html", async () => {
    const env = await createTestEnv();
    const dir = tempDir();
    const index = "<!doctype html><title>fot</title>";
    await Bun.write(join(dir, "index.html"), index);
    await Bun.write(join(dir, "assets", "index-abc.js"), "console.log(1)");
    const web = createApp({ runtime: env.runtime, manager: env.manager, webDir: dir });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const malformed = await web.request("/runs/%E0%A4%A");
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }

    const missing = await web.request("/assets/index-old.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).not.toContain("text/html");

    const asset = await web.request("/assets/index-abc.js");
    expect([asset.status, await asset.text()]).toEqual([200, "console.log(1)"]);
    for (const path of ["/", "/runs/0b4e8f1a-6c2d-4e8a-9f3b-2a1c5d7e9f00", "/runs"]) {
      const page = await web.request(path);
      expect([page.status, await page.text()]).toEqual([200, index]);
    }
  });
});
