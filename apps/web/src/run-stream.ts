import type { RunEvent } from "@fot/core/schema";

/** Delay before a closed stream is reopened. */
export const RECONNECT_MS = 1500;

/** `EventSource.CLOSED`, spelled out because Bun (the test runtime) has no `EventSource`. */
const CLOSED = 2;

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

/** The part of `EventSource` the stream uses; tests pass a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface RunStreamDeps {
  open: (url: string) => EventSourceLike;
  /** Status of `HEAD /api/runs/:id`, or null when the request fails. */
  runStatus: (runId: string) => Promise<number | null>;
  /** Runs `callback` after `ms`; returns a function that cancels it. */
  schedule: (callback: () => void, ms: number) => () => void;
}

const browserDeps: RunStreamDeps = {
  open: (url) => new EventSource(url),
  runStatus: (runId) =>
    fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: "HEAD" }).then(
      (res) => res.status,
      () => null,
    ),
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * Streams `/api/runs/:id/events` into `onEvent` until `done`; returns a function that closes it.
 * The browser closes the stream on a non-200 answer without exposing the status, so a closed stream
 * asks `HEAD /api/runs/:id` first: a permanent 4xx (404 for an unknown, deleted or hidden run) ends
 * it, anything else reopens it after `RECONNECT_MS` (a fresh `snapshot` resyncs the state).
 */
export function connectRunStream(
  runId: string,
  onEvent: (event: RunEvent) => void,
  deps: RunStreamDeps = browserDeps,
): () => void {
  let source: EventSourceLike | null = null;
  let cancelTimer: (() => void) | undefined;
  // Set after `done`, a permanent failure or the caller's close; nothing reopens the stream then.
  let stopped = false;

  const connect = () => {
    const current = deps.open(`/api/runs/${encodeURIComponent(runId)}/events`);
    source = current;
    const handler = (ev: Event) => {
      // The browser also fires a data-less `error` Event on connection problems.
      if (!(ev instanceof MessageEvent) || typeof ev.data !== "string") return;
      const event = JSON.parse(ev.data) as RunEvent;
      onEvent(event);
      if (event.type === "done") {
        stopped = true;
        current.close();
      }
    };
    for (const type of EVENT_TYPES) current.addEventListener(type, handler);
    current.addEventListener("error", (ev) => {
      // A server `error` event is a message; CONNECTING means the browser is retrying itself.
      if (ev instanceof MessageEvent || stopped || source !== current) return;
      if (current.readyState !== CLOSED) return;
      source = null;
      void deps.runStatus(runId).then((status) => {
        if (stopped) return;
        // A 4xx other than 408 and 429 gets the same answer on every retry.
        if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          stopped = true;
          return;
        }
        cancelTimer = deps.schedule(connect, RECONNECT_MS);
      });
    });
  };
  connect();

  return () => {
    stopped = true;
    cancelTimer?.();
    source?.close();
  };
}
