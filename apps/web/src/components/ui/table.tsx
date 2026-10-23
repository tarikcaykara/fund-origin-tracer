import type * as React from "react";
import { cn } from "@/lib/utils.ts";

type TableDensity = "dense" | "default";

function Table({
  className,
  density = "default",
  ...props
}: React.ComponentProps<"table"> & { density?: TableDensity }) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        data-density={density}
        className={cn(
          "w-full caption-bottom type-body [&_tbody_tr]:h-10 data-[density=dense]:[&_tbody_tr]:h-7 data-[density=dense]:[&_tbody_td]:py-1",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("sticky top-0 z-10 bg-muted type-overline [&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({
  className,
  selected = false,
  "data-state": dataState,
  ...props
}: React.ComponentProps<"tr"> & { selected?: boolean; "data-state"?: string | undefined }) {
  return (
    <tr
      data-slot="table-row"
      data-state={selected ? "selected" : dataState}
      className={cn(
        "border-b border-border transition-colors hover:bg-muted has-aria-expanded:bg-muted data-[state=selected]:bg-selection-muted data-[state=selected]:[box-shadow:inset_3px_0_0_var(--selection)]",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({
  className,
  sort,
  children,
  "aria-sort": ariaSort,
  ...props
}: React.ComponentProps<"th"> & { sort?: "ascending" | "descending" | null }) {
  return (
    <th
      data-slot="table-head"
      aria-sort={sort ?? ariaSort}
      className={cn(
        "h-7 px-2 text-left align-middle font-semibold whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    >
      {children}
      {sort ? (
        <span className="ml-1 text-foreground" aria-hidden="true">
          {sort === "ascending" ? "↑" : "↓"}
        </span>
      ) : null}
    </th>
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-2.5 py-2 align-middle whitespace-nowrap type-body data-[density=dense]:py-1",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 type-body-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
