import type { AnalysisResult, LabelCategory, Severity, StopReason } from "@fot/core/schema";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Ban,
  Coins,
  Landmark,
  Layers,
  Route,
  Shuffle,
  Skull,
  Tag,
} from "lucide-react";
import type { InvestigationStatus } from "@/api.ts";
import type { RunPhase } from "@/run-state.ts";

export const CATEGORY_META: Record<
  LabelCategory,
  { label: string; icon: LucideIcon; glyph: string; token: string }
> = {
  exchange: { label: "Exchange", icon: Landmark, glyph: "■", token: "--category-exchange" },
  dex: { label: "DEX", icon: ArrowLeftRight, glyph: "◆", token: "--category-dex" },
  bridge: { label: "Bridge", icon: Route, glyph: "⇄", token: "--category-bridge" },
  mixer: { label: "Mixer", icon: Shuffle, glyph: "◎", token: "--category-mixer" },
  sanctioned: { label: "Sanctioned", icon: Ban, glyph: "⊘", token: "--category-sanctioned" },
  scam: { label: "Scam", icon: Skull, glyph: "✕", token: "--category-scam" },
  defi: { label: "DeFi", icon: Layers, glyph: "◈", token: "--category-defi" },
  token: { label: "Token", icon: Coins, glyph: "●", token: "--category-token" },
  other: { label: "Other", icon: Tag, glyph: "○", token: "--category-other" },
};

export const STOP_TAGS: Record<StopReason, { code: string; text: string }> = {
  entity: { code: "EN", text: "Stopped: labelled entity reached" },
  max_depth: { code: "MD", text: "Stopped: max depth reached" },
  no_candidates: { code: "NC", text: "Stopped: no candidates selected" },
  cycle: { code: "CY", text: "Stopped: cycle detected" },
  sanctioned: { code: "SN", text: "Stopped: sanctioned address reached" },
  mint: { code: "MT", text: "Stopped: token mint reached" },
  max_edges: { code: "ME", text: "Stopped: max edge count reached" },
  timeout: { code: "TO", text: "Stopped: run timed out" },
  cancelled: { code: "CX", text: "Stopped: run cancelled" },
  fetch_failed: { code: "FF", text: "Stopped: fetch failed" },
};

export const SEVERITY_META: Record<Severity, { glyph: string; label: string; token: string }> = {
  high: { glyph: "▲", label: "HIGH", token: "--severity-high" },
  medium: { glyph: "◆", label: "MED", token: "--severity-medium" },
  low: { glyph: "▽", label: "LOW", token: "--severity-low" },
  info: { glyph: "ⓘ", label: "INFO", token: "--severity-info" },
};

export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export type RiskLevel = AnalysisResult["riskLevel"];

export const RISK_META: Record<
  RiskLevel,
  { meter: string; label: string; shortLabel: string; token: string }
> = {
  high: { meter: "▮▮▮", label: "HIGH", shortLabel: "HIGH", token: "--risk-high" },
  medium: { meter: "▮▮▯", label: "MEDIUM", shortLabel: "MED", token: "--risk-medium" },
  low: { meter: "▮▯▯", label: "LOW", shortLabel: "LOW", token: "--risk-low" },
};

export type StatusKind = InvestigationStatus | RunPhase;

export const STATUS_META: Record<StatusKind, { glyph: string; token: string; label: string }> = {
  connecting: { glyph: "●", token: "--status-running", label: "Connecting" },
  running: { glyph: "●", token: "--status-running", label: "Running" },
  paused: { glyph: "❚❚", token: "--status-paused", label: "Paused" },
  completed: { glyph: "■", token: "--status-completed", label: "Completed" },
  cancelled: { glyph: "□", token: "--status-cancelled", label: "Cancelled" },
  failed: { glyph: "✕", token: "--status-failed", label: "Failed" },
  timed_out: { glyph: "✕", token: "--status-failed", label: "Timed out" },
  interrupted: { glyph: "✕", token: "--status-failed", label: "Run interrupted" },
};
