import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, exportJsonUrl } from "@/api.ts";
import { EmptyState } from "@/components/empty-state.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group.tsx";
import { useAsync } from "@/hooks/use-async.ts";
import { useBreakpoint } from "@/hooks/use-breakpoint.ts";
import { ReportDocument } from "./report/document.tsx";

type PaperSize = "A4" | "Letter";

function cssString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/\p{Cc}/gu, " ")}"`;
}

function pageRules(paper: PaperSize, title: string, id: string): string {
  const headerTitle = cssString(`fund-origin-tracer · Evidence report · ${title}`);
  const run = cssString(`run ${id.slice(0, 8)}`);
  return `@page { size: ${paper}; margin: 18mm 16mm 20mm; @top-left { content: ${headerTitle}; color: #555; font: 8pt "IBM Plex Mono", monospace; padding-bottom: 5pt; border-bottom: .5pt solid #aaa; } @top-right { content: ${run}; color: #555; font: 8pt "IBM Plex Mono", monospace; padding-bottom: 5pt; border-bottom: .5pt solid #aaa; } @bottom-left { content: "Powered by Etherscan.io APIs · Tronscan · DefiLlama · OFAC SDN"; color: #555; font: 8pt "IBM Plex Mono", monospace; padding-top: 5pt; border-top: .5pt solid #aaa; } @bottom-right { content: "page " counter(page) " of " counter(pages); color: #555; font: 8pt "IBM Plex Mono", monospace; padding-top: 5pt; border-top: .5pt solid #aaa; } } @page :first { margin-top: 16mm; @top-left { content: none; } @top-right { content: none; } }`;
}

function ReportToolbar({
  id,
  resultAvailable,
  paper,
  onPaperChange,
}: {
  id: string;
  resultAvailable: boolean;
  paper: PaperSize;
  onPaperChange(value: PaperSize): void;
}) {
  return (
    <div
      data-print="hide"
      className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2.5 md:px-5"
    >
      <Button asChild variant="ghost" size="sm" className="mr-auto text-muted-foreground">
        <Link to={`/runs/${id}`}>‹ Back to investigation</Link>
      </Button>
      <div className="hidden items-center gap-2 md:flex">
        <span className="type-mono-sm text-muted-foreground">Paper</span>
        <ToggleGroup
          type="single"
          value={paper}
          aria-label="Paper size"
          onValueChange={(value) => {
            if (value === "A4" || value === "Letter") onPaperChange(value);
          }}
          className="rounded-sm"
        >
          <ToggleGroupItem value="A4" className="min-h-7 px-2.5 type-body-sm">
            A4
          </ToggleGroupItem>
          <ToggleGroupItem value="Letter" className="min-h-7 px-2.5 type-body-sm">
            Letter
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {resultAvailable ? (
        <Button asChild variant="outline" size="sm">
          <a href={exportJsonUrl(id)} download>
            Export JSON
          </a>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled>
          Export JSON
        </Button>
      )}
      <Button size="sm" disabled={!resultAvailable} onClick={() => window.print()}>
        Print / Save PDF
      </Button>
    </div>
  );
}

export function ReportPage() {
  const { id = "" } = useParams();
  const detail = useAsync(() => api.getRun(id), [id]);
  const run = detail.data;
  const [paper, setPaper] = useState<PaperSize>("A4");
  const breakpoint = useBreakpoint();
  const transferLimit = breakpoint === "phone" ? 10 : 20;

  if (detail.error)
    return (
      <p role="alert" className="px-4 py-6 type-body-sm text-destructive">
        {detail.error.message}
      </p>
    );
  if (!run)
    return (
      <div className="px-4 py-6">
        <Skeleton className="mx-auto h-40 w-full max-w-[900px]" />
      </div>
    );

  return (
    <div className="w-full">
      <ReportToolbar
        id={id}
        resultAvailable={Boolean(run.result)}
        paper={paper}
        onPaperChange={setPaper}
      />
      {run.result ? (
        <>
          <style>{pageRules(paper, run.title ?? run.id, id)}</style>
          <style>{`@media print {
            .report .type-body-sm, .report .type-mono-node, .report .type-overline { font-size: 8pt; line-height: 1.4; }
            .report [data-slot="table-container"] { overflow: visible; }
            .report .transfer-table thead { position: static; }
            .report .transfer-table thead th { padding: 1pt 3pt; white-space: nowrap; }
            .report .transfer-table tbody tr { height: auto; }
            .report .transfer-table tbody td { padding: 1pt 3pt; line-height: 1.2; }
          }`}</style>
          <div className="w-full py-0 md:py-5 xl:py-7">
            <ReportDocument
              result={run.result}
              title={run.title ?? run.id}
              notes={run.notes}
              transferLimit={transferLimit}
            />
          </div>
        </>
      ) : (
        <div className="px-4 py-8">
          <EmptyState
            glyph={
              <span aria-hidden="true" className="font-mono text-muted-foreground">
                ▤
              </span>
            }
            title="The report is available when the run finishes"
            body="This investigation does not have a completed analysis result yet."
            action={
              <Button asChild variant="outline">
                <Link to={`/runs/${id}`}>Back to investigation</Link>
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
