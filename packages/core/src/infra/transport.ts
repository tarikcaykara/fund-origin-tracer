import { FotError } from "../errors.ts";

export interface TransportRequest {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}
export interface TransportResponse {
  status: number;
  body: string;
  /** Raw Retry-After header value, when present. */
  retryAfter?: string;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface Recording {
  key: string;
  status: number;
  body: string;
}

/** `GET <url>` with query params sorted and `apikey` removed. Headers never participate. */
export function requestKey(req: { url: string }): string {
  const u = new URL(req.url);
  const params = [...u.searchParams.entries()].filter(([k]) => k.toLowerCase() !== "apikey");
  params.sort(([ak, av], [bk, bv]) =>
    ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1,
  );
  const qs = new URLSearchParams(params).toString();
  return `GET ${u.origin}${u.pathname}${qs ? `?${qs}` : ""}`;
}

export const fetchTransport: Transport = async (req) => {
  let res: Response;
  try {
    res = await fetch(req.url, {
      redirect: "follow",
      headers: { "User-Agent": "fund-origin-tracer", ...req.headers },
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (e) {
    if (req.signal?.aborted) throw e;
    throw new FotError("network_error", `Network request failed: ${String(e)}`, {
      retryable: true,
      cause: e,
    });
  }
  const retryAfter = res.headers.get("retry-after");
  return {
    status: res.status,
    body: await res.text(),
    ...(retryAfter === null ? {} : { retryAfter }),
  };
};

export function RecordingTransport(inner: Transport, sink: (rec: Recording) => void): Transport {
  return async (req) => {
    const res = await inner(req);
    sink({ key: requestKey(req), status: res.status, body: res.body });
    return res;
  };
}

export function FixtureTransport(
  map:
    | ReadonlyMap<string, { status: number; body: string }>
    | Record<string, { status: number; body: string }>,
  opts: { delayMs?: number } = {},
): Transport {
  const lookup = (key: string) =>
    map instanceof Map
      ? map.get(key)
      : (map as Record<string, { status: number; body: string }>)[key];
  return async (req) => {
    const key = requestKey(req);
    const hit = lookup(key);
    if (!hit) throw new FotError("fixture_miss", `No recorded response for ${key}`);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return { status: hit.status, body: hit.body };
  };
}
