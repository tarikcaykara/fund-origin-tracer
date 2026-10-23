import type * as React from "react";
import { cn } from "@/lib/utils.ts";

function Textarea({
  className,
  mono = false,
  ...props
}: React.ComponentProps<"textarea"> & { mono?: boolean }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-muted px-2.5 py-2 type-body transition-[border-color,box-shadow] duration-[var(--duration-fast)] outline-none placeholder:text-faint-foreground hover:border-muted-foreground focus-visible:border-selection focus-visible:ring-[3px] focus-visible:ring-selection-muted disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:bg-destructive-muted aria-[invalid=true]:text-destructive-muted-foreground",
        mono && "type-mono",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
