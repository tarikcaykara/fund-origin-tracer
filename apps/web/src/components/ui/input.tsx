import type * as React from "react";
import { cn } from "@/lib/utils.ts";

function Input({
  className,
  type,
  mono = false,
  ...props
}: React.ComponentProps<"input"> & { mono?: boolean }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8.5 w-full min-w-0 rounded-md border border-input bg-muted px-2.5 py-1 type-body transition-[border-color,box-shadow] duration-[var(--duration-fast)] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-faint-foreground hover:border-muted-foreground focus-visible:border-selection focus-visible:ring-[3px] focus-visible:ring-selection-muted disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:bg-destructive-muted aria-[invalid=true]:text-destructive-muted-foreground",
        mono && "type-mono",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
