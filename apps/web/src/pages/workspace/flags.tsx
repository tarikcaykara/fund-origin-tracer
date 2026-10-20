import type { AnalysisResult, Severity } from "@fot/core/schema";
import { SeverityBadge } from "@/components/badges.tsx";
import { AddressLink, indexAddresses } from "@/components/links.tsx";
import { Button } from "@/components/ui/button.tsx";

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export function sortFlags(flags: AnalysisResult["flags"]): AnalysisResult["flags"] {
  return [...flags].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function FlagsTab({
  result,
  onSelectEdge,
}: {
  result: AnalysisResult;
  onSelectEdge: (edgeId: string) => void;
}) {
  const labels = indexAddresses(result.graph.addresses);
  const flags = sortFlags(result.flags);
  if (flags.length === 0) return <p className="text-sm text-muted-foreground">No flags raised.</p>;
  return (
    <ul className="space-y-4">
      {flags.map((f) => (
        <li key={f.id} className="space-y-2 rounded-md border p-4">
          <div className="flex items-center gap-3">
            <SeverityBadge severity={f.severity} />
            <span className="font-medium">{f.title}</span>
          </div>
          <p className="text-sm">{f.detail}</p>
          {f.evidence.addresses.length > 0 ? (
            <div className="flex flex-wrap gap-3">
              {f.evidence.addresses.map((a) => (
                <AddressLink key={a} chain={result.chain} address={a} labels={labels} />
              ))}
            </div>
          ) : null}
          {f.evidence.edgeIds.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              Evidence transfers:
              {f.evidence.edgeIds.slice(0, 8).map((id) => (
                <Button key={id} variant="outline" size="xs" onClick={() => onSelectEdge(id)}>
                  {id.slice(0, 10)}…
                </Button>
              ))}
              {f.evidence.edgeIds.length > 8 ? (
                <span>+{f.evidence.edgeIds.length - 8} more</span>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
