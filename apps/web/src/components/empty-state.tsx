import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

type EmptyStateProps = {
  title: string;
  body: ReactNode;
  action?: ReactNode;
  className?: string;
  /** 1 when the state is the whole page, 2 when it replaces a tab; 3 under a tab's own heading. */
  headingLevel?: 1 | 2 | 3;
} & ({ icon: LucideIcon; glyph?: never } | { icon?: never; glyph: ReactNode });

export function EmptyState({
  icon: Icon,
  glyph,
  title,
  body,
  action,
  className,
  headingLevel = 3,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
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
        <Heading className="type-heading">{title}</Heading>
        <div className="type-body text-muted-foreground">{body}</div>
      </div>
      {action ? <div>{action}</div> : null}
    </section>
  );
}
