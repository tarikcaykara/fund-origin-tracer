import type { RunEvent } from "@fot/core/schema";
import { useCallback, useEffect, useState } from "react";
import { initialRunState, type RunState, reduceRunEvents } from "./run-state.ts";
import { connectRunStream } from "./run-stream.ts";

interface StreamValue {
  runId: string;
  state: RunState;
  /** Arrival times are local UI metadata, not part of the pure run-event reducer. */
  firstSeen: Record<string, number>;
}

/** Arrival times of new edges: 0 for the edges a snapshot or result brings, `now` for streamed ones. */
function foldFirstSeen(
  firstSeen: Record<string, number>,
  events: readonly RunEvent[],
  now: number,
): Record<string, number> {
  let next = firstSeen;
  let owned = false;
  for (const event of events) {
    if (event.type === "snapshot" || event.type === "result") {
      const edges = event.type === "snapshot" ? event.edges : event.result.graph.edges;
      next = Object.fromEntries(edges.map((edge) => [edge.id, 0]));
      owned = true;
    } else if (event.type === "edge_added" && next[event.edge.id] === undefined) {
      if (!owned) {
        next = { ...next };
        owned = true;
      }
      next[event.edge.id] = now;
    }
  }
  return next;
}

/**
 * Streams `/api/runs/:id/events` into run state through `connectRunStream`, and closes it on
 * unmount. Events are folded once per animation frame, so a burst costs one copy of the edge index
 * and one render. `restart` reopens a finished stream, e.g. after an expand.
 */
export function useRunStream(runId: string): {
  state: RunState;
  firstSeen: Readonly<Record<string, number>>;
  restart: () => void;
} {
  const [stream, setStream] = useState<StreamValue>(() => ({
    runId,
    state: initialRunState,
    firstSeen: {},
  }));
  const [generation, setGeneration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` forces a reconnect.
  useEffect(() => {
    let queue: RunEvent[] = [];
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      const batch = queue;
      queue = [];
      const now = Date.now();
      setStream((current) => {
        const value =
          current.runId === runId ? current : { runId, state: initialRunState, firstSeen: {} };
        const state = reduceRunEvents(value.state, batch);
        const firstSeen = foldFirstSeen(value.firstSeen, batch, now);
        if (value === current && state === current.state && firstSeen === current.firstSeen)
          return current;
        return { runId, state, firstSeen };
      });
    };
    const close = connectRunStream(runId, (event) => {
      queue.push(event);
      frame ??= requestAnimationFrame(flush);
    });
    return () => {
      close();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [runId, generation]);

  const restart = useCallback(() => setGeneration((generation) => generation + 1), []);
  return {
    state: stream.runId === runId ? stream.state : initialRunState,
    firstSeen: stream.runId === runId ? stream.firstSeen : {},
    restart,
  };
}
