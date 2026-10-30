import type { RunEvent } from "@fot/core/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { initialRunState, type RunState, reduceRunEvent } from "./run-state.ts";

const RECONNECT_MS = 1500;

const EVENT_TYPES = [
  "snapshot",
  "status",
  "edge_added",
  "edge_linked",
  "edge_expanded",
  "edge_stopped",
  "progress",
  "expansion",
  "provisional",
  "warning",
  "result",
  "error",
  "done",
] as const satisfies readonly RunEvent["type"][];

interface StreamValue {
  runId: string;
  state: RunState;
  /** Arrival times are local UI metadata, not part of the pure run-event reducer. */
  firstSeen: Record<string, number>;
}

/**
 * Streams `/api/runs/:id/events` into run state. Reconnects (a fresh `snapshot` resyncs the state)
 * until `done`, and closes on unmount. `restart` reopens a finished stream, e.g. after an expand.
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
  const finished = useRef(false);

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
  useEffect(() => {
    finished.current = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
      const handler = (ev: Event) => {
        // The browser also fires a data-less `error` Event on connection problems.
        if (!(ev instanceof MessageEvent) || typeof ev.data !== "string") return;
        const event = JSON.parse(ev.data) as RunEvent;
        onRunEvent(event);
        if (event.type === "done") {
          finished.current = true;
          source?.close();
        }
      };
      for (const type of EVENT_TYPES) source.addEventListener(type, handler);
      source.addEventListener("error", () => {
        if (disposed || finished.current || source?.readyState !== EventSource.CLOSED) return;
        timer = setTimeout(connect, RECONNECT_MS);
      });
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      source?.close();
    };
  }, [runId, generation, onRunEvent]);

  const restart = useCallback(() => setGeneration((generation) => generation + 1), []);
  return {
    state: stream.runId === runId ? stream.state : initialRunState,
    firstSeen: stream.runId === runId ? stream.firstSeen : {},
    restart,
  };
}
