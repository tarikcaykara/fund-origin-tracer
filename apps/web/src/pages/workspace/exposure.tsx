import type { AnalysisResult } from "@fot/core/schema";
import { CategoryBadge } from "@/components/badges.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import { formatUsd } from "@/format.ts";

export function ExposureTab({ result }: { result: AnalysisResult }) {
  const { exposure } = result;
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h3 className="font-medium">By category</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Direct (count)</TableHead>
              <TableHead className="text-right">Direct (USD)</TableHead>
              <TableHead className="text-right">Indirect (count)</TableHead>
              <TableHead className="text-right">Indirect (USD)</TableHead>
              <TableHead className="text-right">Min hops (indirect)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {exposure.byCategory.map((c) => (
              <TableRow key={c.category}>
                <TableCell>
                  <CategoryBadge category={c.category} />
                </TableCell>
                <TableCell className="text-right">{c.direct.count}</TableCell>
                <TableCell className="text-right">{formatUsd(c.direct.usd)}</TableCell>
                <TableCell className="text-right">{c.indirect.count}</TableCell>
                <TableCell className="text-right">{formatUsd(c.indirect.usd)}</TableCell>
                <TableCell className="text-right">{c.indirect.minHops ?? "—"}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell>Unresolved</TableCell>
              <TableCell colSpan={2} className="text-muted-foreground">
                {Object.entries(exposure.unresolved.byReason)
                  .filter(([, v]) => v.count > 0)
                  .map(([reason, v]) => `${reason.replace("_", " ")}: ${v.count}`)
                  .join(", ") || "—"}
              </TableCell>
              <TableCell className="text-right">{exposure.unresolved.count}</TableCell>
              <TableCell className="text-right">{formatUsd(exposure.unresolved.usd)}</TableCell>
              <TableCell />
            </TableRow>
          </TableBody>
        </Table>
        <p className="text-sm text-muted-foreground">
          Terminal volume {formatUsd(exposure.terminalUsd)} · {exposure.unpricedCount} unpriced
          transfer
          {exposure.unpricedCount === 1 ? "" : "s"}
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">By entity (top {exposure.byEntity.length})</h3>
        {exposure.byEntity.length === 0 ? (
          <p className="text-sm text-muted-foreground">No labeled entities were reached.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">USD</TableHead>
                <TableHead className="text-right">Min hops</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exposure.byEntity.map((e) => (
                <TableRow key={`${e.category}:${e.entity}`}>
                  <TableCell>{e.entity}</TableCell>
                  <TableCell>
                    <CategoryBadge category={e.category} />
                  </TableCell>
                  <TableCell className="text-right">{e.count}</TableCell>
                  <TableCell className="text-right">{formatUsd(e.usd)}</TableCell>
                  <TableCell className="text-right">{e.minHops}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
