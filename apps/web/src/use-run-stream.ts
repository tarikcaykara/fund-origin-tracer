import type { RunEvent } from "@fot/core/schema";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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
  "warning",
  "result",
  "error",
  "done",
] as const satisfies readonly RunEvent["type"][];

/**
 * Streams `/api/runs/:id/events` into run state. Reconnects (a fresh `snapshot` resyncs the state)
 * until `done`, and closes on unmount. `restart` reopens a finished stream, e.g. after an expand.
 */
export function useRunStream(runId: string): { state: RunState; restart: () => void } {
  const [state, dispatch] = useReducer(reduceRunEvent, initialRunState);
  const [generation, setGeneration] = useState(0);
  const finished = useRef(false);

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
        dispatch(event);
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
  }, [runId, generation]);

  const restart = useCallback(() => setGeneration((g) => g + 1), []);
  return { state, restart };
}
