import type { LabelCategory, Severity, StopReason } from "@fot/core/schema";
import type { InvestigationStatus } from "@/api.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import {
  CATEGORY_META,
  RISK_META,
  type RiskLevel,
  SEVERITY_META,
  STATUS_META,
  STOP_TAGS,
} from "@/meta.ts";
import type { RunPhase } from "@/run-state.ts";

export function StatusPill({
  status,
  live = false,
}: {
  status: InvestigationStatus | RunPhase;
  live?: boolean;
}) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-border bg-muted px-2 type-mono-node">
      <span aria-hidden="true" className="font-semibold" style={{ color: `var(${meta.token})` }}>
        {meta.glyph}
      </span>
      <span>{meta.label}</span>
      {live && status === "running" ? (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full animate-live-dot"
          style={{ backgroundColor: `var(${meta.token})` }}
        />
      ) : null}
    </span>
  );
}

export function RiskMeter({
  level,
  short = false,
}: {
  level: RiskLevel | null | undefined;
  short?: boolean;
}) {
  if (!level) return <span className="type-mono-node">— PENDING</span>;
  const meta = RISK_META[level];
  return (
    <span className="type-mono-node" style={{ color: `var(${meta.token})` }}>
      {meta.meter} {short ? meta.shortLabel : meta.label}
    </span>
  );
}

export function RiskChip({
  level,
  provisional = false,
  size = "default",
}: {
  level: RiskLevel | null | undefined;
  provisional?: boolean;
  size?: "sm" | "default";
}) {
  if (!level) {
    return (
      <span className="inline-flex h-6 items-center rounded-sm border border-border-strong px-1.5 type-mono-node text-muted-foreground">
        RISK PENDING
      </span>
    );
  }
  const meta = RISK_META[level];
  return (
    <span
      className={
        size === "sm"
          ? "inline-flex min-h-5 items-center gap-1 rounded-sm border px-1.5 type-mono-node"
          : "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 type-mono-node"
      }
      style={{
        borderColor: `var(${meta.token})`,
        borderWidth: "1.5px",
        color: `var(${meta.token})`,
      }}
      data-risk={level}
    >
      <span aria-hidden="true">{meta.meter}</span>
      <span>RISK {meta.label}</span>
      {provisional ? <span>· PROVISIONAL</span> : null}
    </span>
  );
}

export function SeverityTag({ severity }: { severity: Severity }) {
  const meta = SEVERITY_META[severity];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm border border-current px-1.5 py-0.5 type-mono-node"
      style={{ color: `var(${meta.token})` }}
      data-severity={severity}
    >
      <span aria-hidden="true">{meta.glyph}</span> {meta.label}
    </span>
  );
}

export function CategoryTag({ category, label }: { category: LabelCategory; label?: string }) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  return (
    <span
      className="inline-flex items-center gap-1.5 type-body-sm font-medium"
      style={{ color: `var(${meta.token})` }}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {label ?? meta.label}
    </span>
  );
}

export function StopTag({ reason }: { reason: StopReason | null }) {
  if (!reason) return <span className="text-muted-foreground">—</span>;
  const tag = STOP_TAGS[reason];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center rounded-sm border border-border-strong bg-muted px-1.5 py-0.5 font-mono text-3xs font-semibold"
          aria-label={tag.text}
        >
          {tag.code}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tag.text}</TooltipContent>
    </Tooltip>
  );
}

export function DemoChip({ label = "DEMO" }: { label?: string }) {
  return (
    <Badge variant="outline" className="border-dashed border-border-strong text-muted-foreground">
      {label}
    </Badge>
  );
}
