import type { AnalysisResult } from "@fot/core/schema";
import { useMemo } from "react";
import { CategoryTag, SeverityTag } from "@/components/badges.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { AddressChip, indexAddresses } from "@/components/links.tsx";
import { Button } from "@/components/ui/button.tsx";
import { shortAddress } from "@/format.ts";
import { useBreakpoint } from "@/hooks/use-breakpoint.ts";
import { cn } from "@/lib/utils.ts";
import type { Selection } from "@/selection.ts";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 } as const;

export function FlagsTab({
  result,
  onSelect,
}: {
  result: AnalysisResult;
  onSelect: (selection: Selection) => void;
}) {
  const { chain, flags } = result;
  const labels = useMemo(() => indexAddresses(result.graph.addresses), [result.graph.addresses]);
  const phone = useBreakpoint() === "phone";
  const sorted = [...flags].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  if (sorted.length === 0) {
    return (
      <section className="min-w-0 p-3 md:p-5">
        <header className="mb-3">
          <h2 className="type-heading">0 flags</h2>
          <p className="type-body-sm text-muted-foreground">
            Sorted by severity · each flag lists the rule and the evidence it matched.
          </p>
        </header>
        <EmptyState
          glyph="◇"
          title="No flags raised"
          body="No policy rules matched the evidence collected in this trace."
        />
      </section>
    );
  }

  return (
    <section className="min-w-0 p-3 md:p-5">
      <header className="mb-3">
        <h2 className="type-heading">
          {sorted.length} {sorted.length === 1 ? "flag" : "flags"}
        </h2>
        <p className="type-body-sm text-muted-foreground">
          Sorted by severity · each flag lists the rule and the evidence it matched.
        </p>
      </header>
      <ul className="space-y-2">
        {sorted.map((flag) => {
          const addresses = [...new Set(flag.evidence.addresses)];
          const visibleAddresses = addresses.slice(0, phone ? 4 : 8);
          return (
            <li
              key={flag.id}
              className={cn(
                "grid min-w-0 gap-3 rounded-xs border border-border bg-card p-3 md:grid-cols-[64px_minmax(0,1fr)_auto] md:items-start md:p-3.5",
                phone && "grid-cols-1",
              )}
            >
              <div>
                <SeverityTag severity={flag.severity} />
              </div>
              <div className="min-w-0 space-y-2">
                <div>
                  <h3 className="type-heading">{flag.title}</h3>
                  <p className="type-mono-node text-faint-foreground">{flag.id}</p>
                </div>
                <p className="type-body-sm text-muted-foreground">{flag.detail}</p>
                <div className="flex flex-wrap gap-1.5">
                  {visibleAddresses.map((address) => {
                    const category = labels.get(address)?.labels[0]?.category;
                    return (
                      <span
                        key={address}
                        className="inline-flex min-h-11 items-center rounded-xs border border-border-strong px-1.5 type-mono-node md:min-h-6"
                        title={`${category ?? "unlabeled"} · ${address}`}
                      >
                        {category ? (
                          <CategoryTag category={category} label={shortAddress(chain, address)} />
                        ) : (
                          <AddressChip chain={chain} address={address} />
                        )}
                      </span>
                    );
                  })}
                  {addresses.length > visibleAddresses.length ? (
                    <span className="inline-flex min-h-6 items-center rounded-xs border border-border-strong px-1.5 type-mono-node text-muted-foreground">
                      +{addresses.length - visibleAddresses.length} more
                    </span>
                  ) : null}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="justify-self-start text-selection md:justify-self-end"
                onClick={() =>
                  onSelect({
                    kind: "set",
                    addresses,
                    edgeIds: flag.evidence.edgeIds,
                    title: flag.title,
                  })
                }
              >
                Select {addresses.length} addr · {flag.evidence.edgeIds.length} edges in graph →
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
