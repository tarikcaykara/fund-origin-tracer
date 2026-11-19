import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@fot/core/schema";
import { connectRunStream, type EventSourceLike, type RunStreamDeps } from "../src/run-stream.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeSource implements EventSourceLike {
  readyState = CONNECTING;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = CLOSED;
  }

  /** A run event sent by the server. */
  emit(event: RunEvent): void {
    this.readyState = OPEN;
    this.dispatch(event.type, new MessageEvent(event.type, { data: JSON.stringify(event) }));
  }

  /** The browser's data-less connection error; CLOSED after a non-200 answer. */
  fail(readyState: number): void {
    this.readyState = readyState;
    this.dispatch("error", new Event("error"));
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface Scheduled {
  callback: () => void;
  ms: number;
  cancelled: boolean;
}

function start(runId = "run-1") {
  const sources: FakeSource[] = [];
  const statusChecks: string[] = [];
  const scheduled: Scheduled[] = [];
  const events: RunEvent[] = [];
  let pending: PromiseWithResolvers<number | null> | null = null;
  const deps: RunStreamDeps = {
    open: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    runStatus: (id) => {
      statusChecks.push(id);
      pending = Promise.withResolvers<number | null>();
      return pending.promise;
    },
    schedule: (callback, ms) => {
      const entry = { callback, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  const close = connectRunStream(runId, (event) => events.push(event), deps);
  return {
    sources,
    statusChecks,
    events,
    close,
    /**
     * Answers the pending status check. `connectRunStream` subscribed to the promise first, so its
     * continuation has run when this returns.
     */
    answer: async (status: number | null) => {
      const check = pending;
      pending = null;
      check?.resolve(status);
      await check?.promise;
    },
    live: () => scheduled.filter((entry) => !entry.cancelled),
  };
}

describe("connectRunStream", () => {
  test.each([404, 403, 400])("stops for good when the run check answers %d", async (status) => {
    const h = start();
    h.sources[0]?.fail(CLOSED);
    await h.answer(status);
    expect(h.live()).toEqual([]);
    expect(h.statusChecks).toEqual(["run-1"]);
    expect(h.sources).toHaveLength(1);
  });

  test.each([429, 408, 503, null])(
    "reopens after 1.5 s when the run check answers %p",
    async (status) => {
      const h = start();
      h.sources[0]?.fail(CLOSED);
      await h.answer(status);
      expect(h.live().map((entry) => entry.ms)).toEqual([1500]);
      h.live()[0]?.callback();
      expect(h.sources.map((source) => source.url)).toEqual([
        "/api/runs/run-1/events",
        "/api/runs/run-1/events",
      ]);
    },
  );

  test("never reopens a finished stream", async () => {
    const h = start();
    const done: RunEvent = { type: "done", status: "completed" };
    h.sources[0]?.emit(done);
    expect(h.events).toEqual([done]);
    expect(h.sources[0]?.readyState).toBe(CLOSED);
    h.sources[0]?.fail(CLOSED);
    await h.answer(503);
    expect(h.statusChecks).toEqual([]);
    expect(h.live()).toEqual([]);
  });

  test("schedules nothing when closed while the run check is pending", async () => {
    const h = start();
    h.sources[0]?.fail(CLOSED);
    h.close();
    await h.answer(503);
    expect(h.live()).toEqual([]);
    expect(h.sources).toHaveLength(1);
  });

  test("leaves browser retries and server error events alone", async () => {
    const h = start();
    h.sources[0]?.fail(CONNECTING);
    const error: RunEvent = { type: "error", code: "no_result", message: "The run has no result." };
    h.sources[0]?.emit(error);
    await h.answer(503);
    expect(h.events).toEqual([error]);
    expect(h.statusChecks).toEqual([]);
    expect(h.live()).toEqual([]);
  });
});
