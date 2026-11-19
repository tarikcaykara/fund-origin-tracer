import type { RunEvent } from "@fot/core/schema";
import { useCallback, useEffect, useState } from "react";
import { initialRunState, type RunState, reduceRunEvent } from "./run-state.ts";
import { connectRunStream } from "./run-stream.ts";

interface StreamValue {
  runId: string;
  state: RunState;
  /** Arrival times are local UI metadata, not part of the pure run-event reducer. */
  firstSeen: Record<string, number>;
}

/**
 * Streams `/api/runs/:id/events` into run state through `connectRunStream`, and closes it on
 * unmount. `restart` reopens a finished stream, e.g. after an expand.
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

  const onRunEvent = useCallback(
    (event: RunEvent) => {
      setStream((current) => {
        const value =
          current.runId === runId ? current : { runId, state: initialRunState, firstSeen: {} };
        let firstSeen = value.firstSeen;
        if (event.type === "snapshot" || event.type === "result") {
          const edges = event.type === "snapshot" ? event.edges : event.result.graph.edges;
          firstSeen = Object.fromEntries(edges.map((edge) => [edge.id, 0]));
        } else if (event.type === "edge_added" && firstSeen[event.edge.id] === undefined) {
          firstSeen = { ...firstSeen, [event.edge.id]: Date.now() };
        }
        return {
          runId,
          state: reduceRunEvent(value.state, event),
          firstSeen,
        };
      });
    },
    [runId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` forces a reconnect.
  useEffect(() => connectRunStream(runId, onRunEvent), [runId, generation, onRunEvent]);

  const restart = useCallback(() => setGeneration((generation) => generation + 1), []);
  return {
    state: stream.runId === runId ? stream.state : initialRunState,
    firstSeen: stream.runId === runId ? stream.firstSeen : {},
    restart,
  };
}
