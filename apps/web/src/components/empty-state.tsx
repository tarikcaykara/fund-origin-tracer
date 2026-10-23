import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

type EmptyStateProps = {
  title: string;
  body: ReactNode;
  action?: ReactNode;
  className?: string;
} & ({ icon: LucideIcon; glyph?: never } | { icon?: never; glyph: ReactNode });

export function EmptyState({ icon: Icon, glyph, title, body, action, className }: EmptyStateProps) {
  return (
    <section
      className={cn(
        "flex flex-col items-center gap-3 rounded-md border border-dashed border-border-strong p-6 text-center",
        className,
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-md border border-dashed border-border-strong text-muted-foreground">
        {Icon ? <Icon aria-hidden="true" className="size-5" /> : glyph}
      </div>
      <div className="space-y-1">
        <h3 className="type-heading">{title}</h3>
        <div className="type-body text-muted-foreground">{body}</div>
      </div>
      {action ? <div>{action}</div> : null}
    </section>
  );
}
