import type * as React from "react";
import { cn } from "@/lib/utils.ts";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-shimmer rounded-xs bg-border", className)}
      {...props}
    />
  );
}

export { Skeleton };
