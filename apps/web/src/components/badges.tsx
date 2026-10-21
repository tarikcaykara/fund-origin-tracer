import type { Label, LabelCategory, Severity, StopReason } from "@fot/core/schema";
import type { InvestigationStatus } from "@/api.ts";
import { Badge } from "@/components/ui/badge.tsx";
import type { RunPhase } from "@/run-state.ts";

const RISK_VARIANT = { high: "destructive", medium: "default", low: "secondary" } as const;

export function RiskBadge({ level }: { level: "low" | "medium" | "high" | null | undefined }) {
  if (!level) return <Badge variant="outline">Risk: pending</Badge>;
  return <Badge variant={RISK_VARIANT[level]}>Risk: {level}</Badge>;
}

const SEVERITY_VARIANT = {
  high: "destructive",
  medium: "default",
  low: "secondary",
  info: "outline",
} as const;

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge variant={SEVERITY_VARIANT[severity]}>{severity}</Badge>;
}

export function StatusBadge({ status }: { status: InvestigationStatus | RunPhase }) {
  const variant =
    status === "completed"
      ? "secondary"
      : status === "failed" || status === "interrupted"
        ? "destructive"
        : status === "running" || status === "connecting"
          ? "default"
          : "outline";
  return <Badge variant={variant}>{status.replace("_", " ")}</Badge>;
}

export function CategoryBadge({ category }: { category: LabelCategory }) {
  return <Badge variant="outline">{category}</Badge>;
}

export function StopReasonText({ reason }: { reason: StopReason | null }) {
  return <span>{reason ? reason.replace("_", " ") : "—"}</span>;
}

export function LabelList({ labels }: { labels: readonly Label[] }) {
  return (
    <ul className="space-y-1">
      {labels.map((label) => (
        <li key={`${label.origin}:${label.name}`}>
          <Badge variant="outline">{label.category}</Badge> {label.name}{" "}
          <span className="text-xs text-muted-foreground">
            {label.origin} · {label.source}
          </span>
        </li>
      ))}
    </ul>
  );
}
