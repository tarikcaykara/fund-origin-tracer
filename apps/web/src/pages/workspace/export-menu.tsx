import type { CsvKind } from "@fot/core/csv";
import type { AnalysisResult } from "@fot/core/schema";
import { toast } from "sonner";
import { CSV_KINDS, exportCsvUrl, exportJsonUrl } from "@/api.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";

interface ExportOption {
  format: "JSON" | "CSV";
  kind: CsvKind | null;
  label: string;
  rows: number;
  rowLabel: string;
}

function getOptions(result: AnalysisResult): ExportOption[] {
  const counts: Record<CsvKind, number> = {
    edges: result.graph.edges.length,
    convergences: result.convergences.length,
    exposure: result.exposure.entries.length,
    touchpoints: result.exchangeTouchpoints.length,
    addresses: result.graph.addresses.length,
  };
  return [
    {
      format: "JSON",
      kind: null,
      label: "Full result",
      rows: result.graph.edges.length,
      rowLabel: "transfers",
    },
    ...CSV_KINDS.map(({ kind, label }) => ({
      format: "CSV" as const,
      kind,
      label: label.replace(/ \(CSV\)$/, ""),
      rows: counts[kind],
      rowLabel: "rows",
    })),
  ];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function download(runId: string, option: ExportOption): Promise<void> {
  const url = option.kind === null ? exportJsonUrl(runId) : exportCsvUrl(runId, option.kind);
  const response = await fetch(url);
  if (!response.ok) {
    let message = `Export failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Keep the HTTP status as the actionable error when the response is not JSON.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const defaultName =
    option.kind === null ? `fot-${runId}.json` : `fot-${runId}-${option.kind}.csv`;
  const filename = match?.[1] ? decodeURIComponent(match[1].replace(/"$/, "")) : defaultName;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  toast.success(`↓ Exported ${filename}`, {
    description: `${option.rows} ${option.rowLabel} · ${formatSize(blob.size)}`,
  });
}

function ExportAction({ runId, option }: { runId: string; option: ExportOption }) {
  return (
    <DropdownMenuItem
      onSelect={() => {
        void download(runId, option).catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Export failed.");
        });
      }}
      className="flex min-h-9 items-center gap-2 max-md:min-h-11"
    >
      <span className="w-9 shrink-0 type-mono-node text-muted-foreground">{option.format}</span>
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      <span className="shrink-0 type-mono-node text-muted-foreground">
        {option.rows} {option.rowLabel}
      </span>
    </DropdownMenuItem>
  );
}

export function ExportMenu({ runId, result }: { runId: string; result: AnalysisResult | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={!result} aria-haspopup="menu">
          Export ▾
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[260px] p-1">
        {result
          ? getOptions(result).map((option) => (
              <ExportAction
                key={`${option.format}:${option.kind ?? "json"}`}
                runId={runId}
                option={option}
              />
            ))
          : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ExportSubmenu({ runId, result }: { runId: string; result: AnalysisResult | null }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!result} className="min-h-11">
        Export
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[260px] p-1">
        {result
          ? getOptions(result).map((option) => (
              <ExportAction
                key={`${option.format}:${option.kind ?? "json"}`}
                runId={runId}
                option={option}
              />
            ))
          : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
