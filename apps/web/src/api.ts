import type { CsvKind } from "@fot/core/csv";
import type {
  AnalysisResult,
  ChainId,
  Direction,
  Label,
  RunParams,
  RunStatus,
  Seed,
} from "@fot/core/schema";

export type ChainHealth = "ready" | "missing_key";

export interface Health {
  version: string;
  chains: Record<ChainId, ChainHealth>;
  demoOnly: boolean;
  ofacFetchedAt: string | null;
  labelsVersion: string;
}

export interface DemoScenario {
  id: string;
  title: string;
  description: string;
  chain: ChainId;
  direction: Direction;
  /** Size of the recorded run; absent for scenarios recorded without counts. */
  addresses?: number;
  transfers?: number;
}

/** Persisted statuses plus the live-only overlay (`running`, `paused`) and boot recovery. */
export type InvestigationStatus = RunStatus | "running" | "paused" | "interrupted";

/** Row metadata of an investigation (camelCase, no result payload). */
export interface RunSummary {
  id: string;
  chain: ChainId;
  direction: Direction;
  seeds: Seed[];
  params: RunParams;
  status: InvestigationStatus;
  riskLevel: AnalysisResult["riskLevel"] | null;
  title: string | null;
  notes: string | null;
  demo: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

export type RunDetail = RunSummary & { result: AnalysisResult | null };

export interface RunList {
  items: RunSummary[];
  total: number;
  totalAll: number;
}

export interface RunListQuery {
  limit?: number;
  offset?: number;
  q?: string;
  chain?: ChainId;
  status?: InvestigationStatus;
}

/** Body of a live `POST /api/runs`; seed ids are assigned by the server when omitted. */
export interface LiveRunRequest {
  chain: ChainId;
  direction: Direction;
  seeds: { kind: Seed["kind"]; value: string }[];
  maxDepth?: number;
  maxBranches?: number;
  maxEdges?: number;
  minUsd?: number;
  traceThroughEntities?: boolean;
  followUnpriced?: boolean;
  timeoutSec?: number;
}

export interface ScreenResult {
  labels: Label[];
  sanctioned: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new ApiError(0, "network_error", e instanceof Error ? e.message : "Network error.");
  }
  const text = await res.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const err = (body as ErrorEnvelope | null)?.error;
    throw new ApiError(
      res.status,
      typeof err?.code === "string" ? err.code : "http_error",
      typeof err?.message === "string" ? err.message : `Request failed (${res.status}).`,
    );
  }
  return body as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

export const api = {
  health: () => request<Health>("/api/health"),
  demos: () => request<DemoScenario[]>("/api/demo"),
  createRun: (body: LiveRunRequest) => request<{ runId: string }>("/api/runs", json("POST", body)),
  createDemoRun: (demo: string) => request<{ runId: string }>("/api/runs", json("POST", { demo })),
  listRuns: (query: RunListQuery = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== "") qs.set(k, String(v));
    const suffix = qs.size > 0 ? `?${qs}` : "";
    return request<RunList>(`/api/runs${suffix}`);
  },
  getRun: (id: string) => request<RunDetail>(`/api/runs/${enc(id)}`),
  pause: (id: string) =>
    request<{ status: InvestigationStatus }>(`/api/runs/${enc(id)}/pause`, { method: "POST" }),
  resume: (id: string) =>
    request<{ status: InvestigationStatus }>(`/api/runs/${enc(id)}/resume`, { method: "POST" }),
  cancel: (id: string) =>
    request<{ status: InvestigationStatus }>(`/api/runs/${enc(id)}/cancel`, { method: "POST" }),
  expand: (id: string, edgeId: string, maxDepth?: number) =>
    request<{ status: "running" | "paused" }>(
      `/api/runs/${enc(id)}/expand`,
      json("POST", maxDepth === undefined ? { edgeId } : { edgeId, maxDepth }),
    ),
  patchRun: (id: string, fields: { title?: string | null; notes?: string | null }) =>
    request<RunSummary>(`/api/runs/${enc(id)}`, json("PATCH", fields)),
  deleteRun: (id: string) =>
    request<{ deleted: true }>(`/api/runs/${enc(id)}`, { method: "DELETE" }),
  screen: (chain: ChainId, address: string) =>
    request<ScreenResult>(`/api/screen/${enc(chain)}/${enc(address)}`),
};

export function exportJsonUrl(id: string): string {
  return `/api/runs/${enc(id)}/export.json`;
}

export function exportCsvUrl(id: string, kind: CsvKind): string {
  return `/api/runs/${enc(id)}/export.csv?kind=${kind}`;
}

export const CSV_KINDS: { kind: CsvKind; label: string }[] = [
  { kind: "edges", label: "Transfers (CSV)" },
  { kind: "convergences", label: "Linked wallets (CSV)" },
  { kind: "exposure", label: "Exposure (CSV)" },
  { kind: "touchpoints", label: "Exchange touchpoints (CSV)" },
  { kind: "addresses", label: "Addresses (CSV)" },
];
