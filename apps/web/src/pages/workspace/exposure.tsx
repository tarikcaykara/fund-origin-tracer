import type { DerivedAnalysis } from "@fot/core/schema";
import { CategoryTag } from "@/components/badges.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import { formatUsd } from "@/format.ts";
import { useBreakpoint } from "@/hooks/use-breakpoint.ts";
import { CATEGORY_META } from "@/meta.ts";

export function ExposureTab({ result }: { result: DerivedAnalysis }) {
  const { exposure } = result;
  const phone = useBreakpoint() === "phone";
  const byEntityTotalUsd = exposure.byEntity.reduce((sum, entity) => sum + entity.usd, 0);
  const unresolvedReasons = Object.entries(exposure.unresolved.byReason).filter(
    ([, value]) => value.count > 0,
  );

  return (
    <div className="grid min-w-0 gap-6 p-3 md:p-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,1fr)] xl:gap-5">
      <section className="min-w-0 space-y-2">
        <div>
          <h2 className="type-heading">By category</h2>
          <p className="type-body-sm text-muted-foreground">
            Value reaching labelled categories at the end of traced branches.
          </p>
        </div>
        <div className="overflow-hidden rounded-xs border border-border">
          <Table density="dense">
            <TableHeader>
              <TableRow>
                <TableHead>CATEGORY</TableHead>
                {!phone ? <TableHead className="text-right">DIRECT</TableHead> : null}
                {!phone ? <TableHead className="text-right">DIRECT USD</TableHead> : null}
                {!phone ? <TableHead className="text-right">INDIRECT</TableHead> : null}
                <TableHead className="text-right">{phone ? "USD" : "INDIRECT USD"}</TableHead>
                <TableHead className="text-right">MIN HOPS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exposure.byCategory.map((entry) => (
                <TableRow key={entry.category}>
                  <TableCell>
                    <CategoryTag category={entry.category} />
                  </TableCell>
                  {!phone ? (
                    <TableCell className="text-right type-mono-sm">{entry.direct.count}</TableCell>
                  ) : null}
                  {!phone ? (
                    <TableCell className="text-right type-mono-sm">
                      {formatUsd(entry.direct.usd)}
                    </TableCell>
                  ) : null}
                  {!phone ? (
                    <TableCell className="text-right type-mono-sm">
                      {entry.indirect.count}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right type-mono-sm">
                    {formatUsd(entry.indirect.usd)}
                  </TableCell>
                  <TableCell className="text-right type-mono-sm">
                    {entry.indirect.minHops ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted">
                <TableCell className="align-top">
                  <span className="type-mono-node">Unresolved</span>
                  {unresolvedReasons.length > 0 ? (
                    <ul className="mt-1 space-y-1 text-left type-mono-node text-muted-foreground">
                      {unresolvedReasons.map(([reason, value]) => (
                        <li key={reason}>
                          ↳ {reason.replaceAll("_", " ")} · {value.count} branches&nbsp;{" "}
                          {formatUsd(value.usd)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </TableCell>
                {!phone ? (
                  <>
                    <TableCell className="text-right type-mono-sm">—</TableCell>
                    <TableCell className="text-right type-mono-sm">—</TableCell>
                    <TableCell className="text-right type-mono-sm">
                      {exposure.unresolved.count}
                    </TableCell>
                  </>
                ) : null}
                <TableCell className="text-right type-mono-sm">
                  {formatUsd(exposure.unresolved.usd)}
                </TableCell>
                <TableCell className="text-right type-mono-sm">—</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <p className="type-mono-node text-muted-foreground">
          Terminal value total {formatUsd(exposure.terminalUsd)} · {exposure.unpricedCount} unpriced
          transfer{exposure.unpricedCount === 1 ? "" : "s"}
        </p>
      </section>

      <section className="min-w-0 space-y-2">
        <div>
          <h2 className="type-heading">By entity</h2>
          <p className="type-body-sm text-muted-foreground">
            Labelled entities ranked by terminal value.
          </p>
        </div>
        {exposure.byEntity.length === 0 ? (
          <EmptyState
            glyph="◇"
            title="No labelled entities reached"
            body="No terminal transfers in this trace matched a labelled entity."
          />
        ) : (
          <ul className="divide-y divide-border rounded-xs border border-border bg-card">
            {exposure.byEntity.map((entity) => {
              const share = byEntityTotalUsd > 0 ? (entity.usd / byEntityTotalUsd) * 100 : 0;
              const color = `var(${CATEGORY_META[entity.category].token})`;
              return (
                <li key={`${entity.category}:${entity.entity}`} className="space-y-2 px-3 py-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate type-body font-medium">{entity.entity}</p>
                      <CategoryTag category={entity.category} />
                    </div>
                    <span className="shrink-0 type-mono-sm">{formatUsd(entity.usd)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${share}%`, backgroundColor: color }}
                    />
                  </div>
                  <p className="type-mono-node text-muted-foreground">
                    {entity.count}× · ≥{entity.minHops} hops · {share.toFixed(1)}%
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
