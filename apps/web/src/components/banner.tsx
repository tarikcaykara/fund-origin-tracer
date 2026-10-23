import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

const TONE_CLASSES = {
  warning: "border-warning-border bg-warning text-warning-foreground",
  destructive: "border-destructive-border bg-destructive-muted text-destructive-muted-foreground",
  neutral: "border-border bg-card text-foreground",
} as const;

export function Banner({
  tone,
  tag,
  children,
  actions,
  className,
}: {
  tone: keyof typeof TONE_CLASSES;
  tag: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <aside
      role={tone === "destructive" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border px-4 py-2.5 type-body",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <strong className="mr-2 type-mono-node">{tag}</strong>
        {children}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </aside>
  );
}
