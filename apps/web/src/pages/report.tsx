import type { AnalysisResult } from "@fot/core/schema";
import { Link, useParams } from "react-router";
import { api } from "@/api.ts";
import { RiskBadge, SeverityBadge } from "@/components/badges.tsx";
import { AddressLink, indexAddresses, TxLink } from "@/components/links.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import {
  assetSymbol,
  chainName,
  directionName,
  formatAmount,
  formatTimestamp,
  formatUsd,
} from "@/format.ts";
import { useAsync } from "@/hooks/use-async.ts";
import { ExposureTab } from "./workspace/exposure.tsx";
import { sortFlags } from "./workspace/flags.tsx";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ReportBody({ result, title }: { result: AnalysisResult; title: string }) {
  const { chain, params } = result;
  const labels = indexAddresses(result.graph.addresses);
  const edges = [...result.graph.edges].sort((a, b) => a.depth - b.depth);
  const flags = sortFlags(result.flags);

  return (
    <article className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {chainName(chain)} · {directionName(result.direction)} · run {result.runId} · status{" "}
          {result.status.replace("_", " ")}
        </p>
      </header>

      <Section title="Summary">
        <p>
          <RiskBadge level={result.riskLevel} />
        </p>
        {flags.length === 0 ? (
          <p className="text-sm text-muted-foreground">No flags raised.</p>
        ) : (
          <ul className="space-y-2">
            {flags.map((f) => (
              <li key={f.id} className="text-sm">
                <SeverityBadge severity={f.severity} /> <strong>{f.title}</strong> — {f.detail}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Parameters and seeds">
        <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Max depth</dt>
          <dd>{params.maxDepth}</dd>
          <dt className="text-muted-foreground">Max branches</dt>
          <dd>{params.maxBranches}</dd>
          <dt className="text-muted-foreground">Max edges</dt>
          <dd>{params.maxEdges}</dd>
          <dt className="text-muted-foreground">Min USD</dt>
          <dd>{params.minUsd}</dd>
          <dt className="text-muted-foreground">Trace through entities</dt>
          <dd>{params.traceThroughEntities ? "yes" : "no"}</dd>
          <dt className="text-muted-foreground">Follow unpriced tokens</dt>
          <dd>{params.followUnpriced ? "yes" : "no"}</dd>
          <dt className="text-muted-foreground">Timeout</dt>
          <dd>{params.timeoutSec}s</dd>
        </dl>
        <ul className="space-y-1 text-sm">
          {result.seeds.map((s) => (
            <li key={s.id}>
              {s.id}:{" "}
              {s.kind === "tx" ? (
                <TxLink chain={chain} hash={s.value} />
              ) : (
                <AddressLink chain={chain} address={s.value} labels={labels} />
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Data sources">
        <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Explorer</dt>
          <dd>{result.dataSources.explorer === "tronscan" ? "Tronscan" : "Etherscan API V2"}</dd>
          <dt className="text-muted-foreground">Prices</dt>
          <dd>DefiLlama</dd>
          <dt className="text-muted-foreground">Labels version</dt>
          <dd>
            {result.dataSources.labelsVersion}
            {result.dataSources.localLabels ? " + local overrides" : ""}
          </dd>
          <dt className="text-muted-foreground">OFAC SDN fetched</dt>
          <dd>{result.dataSources.ofacFetchedAt ?? "not available"}</dd>
          <dt className="text-muted-foreground">Policy</dt>
          <dd>
            v{result.policy.version}
            {result.policy.overridden ? " (overridden)" : " (default)"}
          </dd>
          <dt className="text-muted-foreground">Started / finished</dt>
          <dd>
            {result.startedAt} / {result.finishedAt}
          </dd>
          <dt className="text-muted-foreground">API calls / cache hits</dt>
          <dd>
            {result.stats.apiCalls} / {result.stats.cacheHits}
          </dd>
        </dl>
        {result.warnings.length > 0 ? (
          <ul className="text-sm">
            {result.warnings.map((w) => (
              <li key={`${w.code}:${w.message}`}>
                {w.code}: {w.message}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Exposure">
        <ExposureTab result={result} />
      </Section>

      <Section title="Exchange touchpoints">
        {result.exchangeTouchpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">No exchange was reached.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Exchange</TableHead>
                <TableHead>Counterparty</TableHead>
                <TableHead>Tx</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">USD</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.exchangeTouchpoints.map((t) => (
                <TableRow
                  key={`${t.kind}:${t.txHash}:${t.exchangeAddress}:${t.assetId}:${t.amount}`}
                >
                  <TableCell>{t.kind}</TableCell>
                  <TableCell>{t.entity}</TableCell>
                  <TableCell>
                    {t.counterparty ? (
                      <AddressLink chain={chain} address={t.counterparty} labels={labels} />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <TxLink chain={chain} hash={t.txHash} />
                  </TableCell>
                  <TableCell className="text-right">
                    {formatAmount(t.amount)} {t.symbol}
                  </TableCell>
                  <TableCell className="text-right">{formatUsd(t.usd)}</TableCell>
                  <TableCell>{formatTimestamp(t.timestamp)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Linked wallets">
        {result.convergences.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No unlabeled address was shared across seeds or branches.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {result.convergences.map((c) => (
              <li key={`${c.role}:${c.address}`}>
                <AddressLink chain={chain} address={c.address} labels={labels} /> —{" "}
                {c.role.replace("_", " ")},{" "}
                {c.kinds.map((k) => k.replaceAll("_", " ")).join(" and ")},{" "}
                {c.counterparties.length} counterpart{c.counterparties.length === 1 ? "y" : "ies"},{" "}
                {formatUsd(c.usd)}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Transfers">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Depth</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">USD</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Tx</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {edges.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{e.depth}</TableCell>
                <TableCell>
                  <AddressLink chain={chain} address={e.from} labels={labels} />
                </TableCell>
                <TableCell>
                  <AddressLink chain={chain} address={e.to} labels={labels} />
                </TableCell>
                <TableCell className="text-right">
                  {formatAmount(e.transfer.amount)} {assetSymbol(e.transfer.asset)}
                </TableCell>
                <TableCell className="text-right">{formatUsd(e.usd)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatTimestamp(e.transfer.timestamp)}
                </TableCell>
                <TableCell>
                  <TxLink chain={chain} hash={e.transfer.txHash} />
                </TableCell>
                <TableCell>
                  {e.status === "stopped"
                    ? `stopped: ${e.stopReason?.replace("_", " ")}`
                    : e.status}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="Methodology and limitations">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            At each hop the next transfer is chosen heuristically (same asset, similar amount, close
            in time). Account-model chains cannot prove exact attribution of funds.
          </li>
          <li>
            Explorer free tiers cap each listing at a few pages, so very busy addresses may be
            truncated.
          </li>
          <li>On TRON, swap-through detection is limited to seed transactions.</li>
          <li>
            Labels come from bundled public sources, optional local overrides and the OFAC SDN list;
            an unlabeled address is not a clean address.
          </li>
          <li>
            Tracing stops at labeled exchanges, DEXes, bridges and mixers unless told otherwise.
          </li>
        </ul>
      </Section>

      <Section title="Disclaimer">
        <p className="text-sm text-muted-foreground">
          This report is a heuristic analysis of public blockchain data. It is not legal advice and
          not an accusation against any party. Verify findings independently before acting on them.
        </p>
      </Section>
    </article>
  );
}

export function ReportPage() {
  const { id = "" } = useParams();
  const detail = useAsync(() => api.getRun(id), [id]);
  const run = detail.data;

  if (detail.error) return <p className="text-destructive">{detail.error.message}</p>;
  if (!run) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-6">
      <div className="flex gap-2 print:hidden">
        <Button variant="outline" asChild>
          <Link to={`/runs/${id}`}>Back to investigation</Link>
        </Button>
        <Button onClick={() => window.print()} disabled={!run.result}>
          Print report
        </Button>
      </div>
      {run.result ? (
        <ReportBody result={run.result} title={run.title ?? run.id} />
      ) : (
        <p className="text-sm text-muted-foreground">
          This investigation has no result yet (status: {run.status.replace("_", " ")}).
        </p>
      )}
    </div>
  );
}
