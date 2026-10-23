import type { AnalysisResult, ChainId, StopReason } from "@fot/core/schema";
import type { ReactNode } from "react";
import { CategoryTag, SeverityTag } from "@/components/badges.tsx";
import { ExplorerLink } from "@/components/links.tsx";
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
  formatUtcMinute,
  fullAddress,
  shortAddress,
} from "@/format.ts";
import { cn } from "@/lib/utils.ts";
import { RISK_META, STOP_TAGS } from "@/meta.ts";

function Section({
  number,
  title,
  children,
  className,
}: {
  number: number;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-2.5", className)}>
      <h2 className="type-heading">
        {number}. {title}
      </h2>
      {children}
    </section>
  );
}

function MetaRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(6.5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 type-mono-sm leading-5 md:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] print:grid-cols-[minmax(6.5rem,auto)_minmax(0,1fr)]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReportAddress({ chain, address }: { chain: ChainId; address: string }) {
  const normalized = fullAddress(chain, address);
  return (
    <ExplorerLink chain={chain} kind="address" value={normalized}>
      <span className="print:hidden">{shortAddress(chain, normalized)}</span>
      <span className="address-full hidden break-all print:inline">{normalized}</span>
    </ExplorerLink>
  );
}

function TransferAddress({ chain, address }: { chain: ChainId; address: string }) {
  return <span className="break-all">{shortAddress(chain, address)}</span>;
}

function FlagList({ result }: { result: AnalysisResult }) {
  if (result.flags.length === 0)
    return <p className="type-body-sm text-muted-foreground">No flags were raised.</p>;
  return (
    <div>
      {result.flags.map((flag) => (
        <div
          key={flag.id}
          className="flag grid grid-cols-[68px_minmax(0,1fr)] gap-2 border-t border-border py-1.5 max-sm:grid-cols-1 print:grid-cols-[58px_minmax(0,1fr)]"
          data-severity={flag.severity}
        >
          <SeverityTag severity={flag.severity} />
          <p className="type-body-sm leading-5">
            <strong>{flag.title}.</strong>{" "}
            <span className="text-muted-foreground">{flag.detail}</span>
          </p>
        </div>
      ))}
    </div>
  );
}

function ExposureTables({ result }: { result: AnalysisResult }) {
  const exposure = result.exposure;
  return (
    <>
      <div className="hidden md:block print:block">
        <Table
          density="dense"
          className="table-fixed text-xs [&_th]:px-1 [&_td]:px-1 [&_td]:py-1 [&_td]:whitespace-normal print:text-[8pt]"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-[28%]">CATEGORY</TableHead>
              <TableHead className="text-right">DIRECT USD</TableHead>
              <TableHead className="text-right">INDIRECT USD</TableHead>
              <TableHead className="text-right">COUNT</TableHead>
              <TableHead className="text-right">MIN HOPS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {exposure.byCategory.map((row) => (
              <TableRow key={row.category}>
                <TableCell>
                  <CategoryTag category={row.category} />
                </TableCell>
                <TableCell className="text-right type-mono-sm">
                  {formatUsd(row.direct.usd)}
                </TableCell>
                <TableCell className="text-right type-mono-sm">
                  {formatUsd(row.indirect.usd)}
                </TableCell>
                <TableCell className="text-right type-mono-sm">
                  {row.direct.count + row.indirect.count}
                </TableCell>
                <TableCell className="text-right type-mono-sm">
                  {row.indirect.minHops === null ? "—" : `≥${row.indirect.minHops}`}
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="font-semibold">○ unresolved</TableCell>
              <TableCell className="text-right type-mono-sm">—</TableCell>
              <TableCell className="text-right type-mono-sm">
                {formatUsd(exposure.unresolved.usd)}
              </TableCell>
              <TableCell className="text-right type-mono-sm">{exposure.unresolved.count}</TableCell>
              <TableCell className="text-right type-mono-sm">—</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <div className="md:hidden print:hidden">
        <Table
          density="dense"
          className="table-fixed text-xs [&_th]:px-1 [&_td]:px-1 [&_td]:py-1 [&_td]:whitespace-normal"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-[55%]">CATEGORY</TableHead>
              <TableHead className="text-right">INDIRECT USD</TableHead>
              <TableHead className="text-right">MIN HOPS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {exposure.byCategory.map((row) => (
              <TableRow key={row.category}>
                <TableCell>
                  <CategoryTag category={row.category} />
                  <span className="block type-mono-node text-muted-foreground">
                    Direct {formatUsd(row.direct.usd)} · {row.direct.count + row.indirect.count}{" "}
                    total
                  </span>
                </TableCell>
                <TableCell className="text-right type-mono-sm">
                  {formatUsd(row.indirect.usd)}
                </TableCell>
                <TableCell className="text-right type-mono-sm">
                  {row.indirect.minHops === null ? "—" : `≥${row.indirect.minHops}`}
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="font-semibold">
                ○ unresolved{" "}
                <span className="block type-mono-node text-muted-foreground">
                  {exposure.unresolved.count} transfers
                </span>
              </TableCell>
              <TableCell className="text-right type-mono-sm">
                {formatUsd(exposure.unresolved.usd)}
              </TableCell>
              <TableCell className="text-right type-mono-sm">—</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p className="type-body-sm leading-5 text-muted-foreground">
        By entity:{" "}
        {exposure.byEntity.length
          ? exposure.byEntity
              .map(
                (entity) =>
                  `${entity.entity} ${formatUsd(entity.usd)} (${entity.count}×, ≥${entity.minHops} hops)`,
              )
              .join(" · ")
          : "no labeled entities"}
        . Terminal value total {formatUsd(exposure.terminalUsd)}.
      </p>
    </>
  );
}

function TouchpointTable({ result }: { result: AnalysisResult }) {
  const { chain, exchangeTouchpoints } = result;
  if (exchangeTouchpoints.length === 0)
    return (
      <p className="type-body-sm text-muted-foreground">No exchange touchpoints were found.</p>
    );
  return (
    <>
      <div className="hidden md:block print:block">
        <Table
          density="dense"
          className="table-fixed text-xs [&_th]:px-1 [&_td]:px-1 [&_td]:py-1 [&_td]:whitespace-normal print:text-[8pt]"
        >
          <TableHeader>
            <TableRow>
              <TableHead>ENTITY</TableHead>
              <TableHead>EXCHANGE WALLET</TableHead>
              <TableHead>COUNTERPARTY</TableHead>
              <TableHead className="text-right">AMOUNT</TableHead>
              <TableHead className="text-right">USD</TableHead>
              <TableHead className="text-right">HOP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {exchangeTouchpoints.map((point) => (
              <TableRow
                key={`${point.kind}:${point.txHash}:${point.exchangeAddress}:${point.assetId}:${point.amount}`}
              >
                <TableCell className="break-words">■ {point.entity}</TableCell>
                <TableCell>
                  <ReportAddress chain={chain} address={point.exchangeAddress} />
                </TableCell>
                <TableCell>
                  {point.counterparty ? (
                    <ReportAddress chain={chain} address={point.counterparty} />
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-right type-mono-sm">
                  {formatAmount(point.amount)} {point.symbol}
                </TableCell>
                <TableCell className="text-right type-mono-sm">{formatUsd(point.usd)}</TableCell>
                <TableCell className="text-right type-mono-sm">{point.depth}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="md:hidden print:hidden">
        <Table
          density="dense"
          className="table-fixed text-xs [&_th]:px-1 [&_td]:px-1 [&_td]:py-1 [&_td]:whitespace-normal"
        >
          <TableHeader>
            <TableRow>
              <TableHead>ENTITY</TableHead>
              <TableHead className="text-right">USD</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {exchangeTouchpoints.map((point) => (
              <TableRow
                key={`${point.kind}:${point.txHash}:${point.exchangeAddress}:${point.assetId}:${point.amount}`}
              >
                <TableCell className="break-words">
                  <span className="block font-medium">■ {point.entity}</span>
                  <span className="block type-mono-node text-muted-foreground">
                    Wallet <ReportAddress chain={chain} address={point.exchangeAddress} /> ·
                    Counterparty{" "}
                    {point.counterparty ? (
                      <ReportAddress chain={chain} address={point.counterparty} />
                    ) : (
                      "—"
                    )}
                  </span>
                  <span className="block type-mono-node text-muted-foreground">
                    {formatAmount(point.amount)} {point.symbol} · hop {point.depth}
                  </span>
                </TableCell>
                <TableCell className="text-right type-mono-sm">{formatUsd(point.usd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function LinkedWalletTable({ result }: { result: AnalysisResult }) {
  if (result.convergences.length === 0)
    return <p className="type-body-sm text-muted-foreground">No linked wallets were identified.</p>;
  return (
    <>
      <p className="type-body-sm leading-5 text-muted-foreground">
        {result.convergences.some((wallet) => wallet.kinds.includes("shared_across_seeds"))
          ? "These addresses are shared across traced seeds or branches."
          : "No wallet is shared across seeds; these are common sources or destinations within the trace."}
      </p>
      <div className="hidden md:block print:block">
        <Table
          density="dense"
          className="table-fixed text-xs [&_th]:px-1 [&_td]:px-1 [&_td]:py-1 [&_td]:whitespace-normal print:text-[8pt]"
        >
          <TableHeader>
            <TableRow>
              <TableHead>ADDRESS</TableHead>
              <TableHead>ROLE</TableHead>
              <TableHead className="text-right">COUNTERPARTIES</TableHead>
              <TableHead className="text-right">USD</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.convergences.map((wallet) => (
              <TableRow key={`${wallet.role}:${wallet.address}`}>
                <TableCell>
                  <ReportAddress chain={result.chain} address={wallet.address} />
                </TableCell>
                <TableCell>{wallet.role.replaceAll("_", " ")}</TableCell>
                <TableCell className="text-right type-mono-sm">
                  {wallet.counterparties.length}
                </TableCell>
                <TableCell className="text-right type-mono-sm">{formatUsd(wallet.usd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="md:hidden print:hidden">
        <Table
          density="dense"
          className="table-fixed text-xs [&_th]:px-1 [&_td]:px-1 [&_td]:py-1 [&_td]:whitespace-normal"
        >
          <TableHeader>
            <TableRow>
              <TableHead>ADDRESS / ROLE</TableHead>
              <TableHead className="text-right">USD</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.convergences.map((wallet) => (
              <TableRow key={`${wallet.role}:${wallet.address}`}>
                <TableCell>
                  <ReportAddress chain={result.chain} address={wallet.address} />
                  <span className="block type-mono-node text-muted-foreground">
                    {wallet.role.replaceAll("_", " ")} · {wallet.counterparties.length}{" "}
                    counterparties
                  </span>
                </TableCell>
                <TableCell className="text-right type-mono-sm">{formatUsd(wallet.usd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function TransfersTable({ result, limit }: { result: AnalysisResult; limit: number }) {
  const edges = [...result.graph.edges].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const aUsd = a.usd ?? Number.NEGATIVE_INFINITY;
    const bUsd = b.usd ?? Number.NEGATIVE_INFINITY;
    return aUsd === bUsd ? 0 : aUsd > bUsd ? -1 : 1;
  });
  const visibleCount = Math.min(edges.length, limit);
  const statusText = (
    status: AnalysisResult["graph"]["edges"][number]["status"],
    reason: StopReason | null,
  ) => {
    if (status === "stopped")
      return reason ? STOP_TAGS[reason].text.replace("Stopped: ", "") : "stopped";
    return status;
  };
  return (
    <>
      <div className="hidden md:block print:block">
        <Table
          density="dense"
          className="transfer-table table-fixed text-xs [&_th]:px-1 [&_td]:px-1 [&_td]:py-1 [&_td]:whitespace-normal print:text-[8pt]"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-[5%]">HOP</TableHead>
              <TableHead className="w-[14%]">TIME (UTC)</TableHead>
              <TableHead className="w-[13%]">FROM</TableHead>
              <TableHead className="w-[13%]">TO</TableHead>
              <TableHead className="w-[19%] text-right">AMOUNT</TableHead>
              <TableHead className="w-[14%] text-right">USD</TableHead>
              <TableHead className="w-[22%]">STATUS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {edges.map((edge, index) => (
              <TableRow
                key={edge.id}
                className={index >= visibleCount ? "hidden print:table-row" : ""}
              >
                <TableCell className="type-mono-sm">{edge.depth}</TableCell>
                <TableCell className="type-mono-sm">
                  {formatTimestamp(edge.transfer.timestamp).replace(" UTC", "")}
                </TableCell>
                <TableCell className="type-mono-node">
                  <TransferAddress chain={result.chain} address={edge.from} />
                </TableCell>
                <TableCell className="type-mono-node">
                  <TransferAddress chain={result.chain} address={edge.to} />
                </TableCell>
                <TableCell className="text-right type-mono-sm">
                  {formatAmount(edge.transfer.amount)} {assetSymbol(edge.transfer.asset)}
                </TableCell>
                <TableCell className="text-right type-mono-sm">{formatUsd(edge.usd)}</TableCell>
                <TableCell className="type-mono-sm">
                  {statusText(edge.status, edge.stopReason)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="md:hidden print:hidden">
        <Table
          density="dense"
          className="table-fixed text-xs [&_th]:px-1 [&_td]:px-1 [&_td]:py-1 [&_td]:whitespace-normal"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-[10%]">HOP</TableHead>
              <TableHead>FROM → TO</TableHead>
              <TableHead className="w-[28%] text-right">AMOUNT</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {edges.slice(0, visibleCount).map((edge) => (
              <TableRow key={edge.id}>
                <TableCell className="type-mono-sm">{edge.depth}</TableCell>
                <TableCell className="type-mono-node">
                  <TransferAddress chain={result.chain} address={edge.from} /> →{" "}
                  <TransferAddress chain={result.chain} address={edge.to} />
                  <span className="block type-mono-node text-muted-foreground">
                    {formatTimestamp(edge.transfer.timestamp).replace(" UTC", "")} ·{" "}
                    {formatUsd(edge.usd)} · {statusText(edge.status, edge.stopReason)}
                  </span>
                </TableCell>
                <TableCell className="text-right type-mono-node">
                  {formatAmount(edge.transfer.amount)} {assetSymbol(edge.transfer.asset)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {edges.length > limit ? (
        <p className="type-mono-sm text-muted-foreground print:hidden">
          Showing {visibleCount} of {edges.length} · all transfers are included when printed or
          exported
        </p>
      ) : null}
    </>
  );
}

function severitySummary(result: AnalysisResult): string {
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const flag of result.flags) counts[flag.severity] += 1;
  return `${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info flags`;
}

function exchangeSummary(result: AnalysisResult): {
  total: number;
  entities: string;
  minHops: number | null;
} {
  const exchangeCategory = result.exposure.byCategory.find(
    (category) => category.category === "exchange",
  );
  const total = (exchangeCategory?.direct.usd ?? 0) + (exchangeCategory?.indirect.usd ?? 0);
  const entities = result.exposure.byEntity
    .filter((entity) => entity.category === "exchange")
    .sort((a, b) => b.usd - a.usd);
  const names = entities.slice(0, 2).map((entity) => entity.entity);
  return {
    total,
    entities: names.length ? names.join(" and ") : "no named exchange entities",
    minHops: entities.length
      ? entities.reduce(
          (minimum, entity) => Math.min(minimum, entity.minHops),
          Number.POSITIVE_INFINITY,
        )
      : null,
  };
}

function ReportDocument({
  result,
  title,
  notes,
  transferLimit,
}: {
  result: AnalysisResult;
  title: string;
  notes: string | null;
  transferLimit: number;
}) {
  const severityCounts = severitySummary(result);
  const exposure = exchangeSummary(result);
  const risk = RISK_META[result.riskLevel];
  const params = result.params;
  const source = result.direction === "backward" ? "SOURCE OF FUNDS" : "DESTINATION OF FUNDS";
  const sources = [
    ["explorer", result.dataSources.explorer === "tronscan" ? "Tronscan" : "Etherscan API V2"],
    ["prices", "DefiLlama"],
    [
      "labels",
      `${result.dataSources.labelsVersion} · local: ${result.dataSources.localLabels ? "loaded" : "none"}`,
    ],
    [
      "OFAC SDN",
      result.dataSources.ofacFetchedAt
        ? `fetched ${formatUtcMinute(result.dataSources.ofacFetchedAt)}`
        : "not available",
    ],
    ["started", formatUtcMinute(result.startedAt)],
    ["finished", formatUtcMinute(result.finishedAt)],
    ["requests", `${result.stats.apiCalls} API calls · ${result.stats.cacheHits} cache hits`],
    [
      "policy",
      `v${result.policy.version} · ${result.policy.overridden ? "overridden" : "default"}`,
    ],
  ] as [string, ReactNode][];
  const parameterRows: [string, ReactNode][] = [
    ["chain", chainName(result.chain).toLowerCase()],
    ["direction", `${result.direction} (${directionName(result.direction).toLowerCase()})`],
    ["max depth", params.maxDepth],
    ["max branches", params.maxBranches],
    ["max edges", params.maxEdges],
    ["min USD", formatUsd(params.minUsd)],
    ["through entities", String(params.traceThroughEntities)],
    ["follow unpriced", String(params.followUnpriced)],
    ["timeout", `${params.timeoutSec}s`],
  ];
  return (
    <article className="report mx-auto w-full bg-card text-foreground px-4 py-5 md:max-w-[720px] md:p-8 md:shadow-page xl:max-w-[900px] xl:p-14 print:max-w-none print:p-0 print:shadow-none">
      <div className="space-y-6 md:space-y-7 print:space-y-0">
        <header className="space-y-2 border-b-2 border-foreground pb-4">
          <p className="type-overline text-muted-foreground">EVIDENCE REPORT · {source}</p>
          <h1 className="type-title !text-[22px] !font-bold tracking-[-.015em] md:!text-[30px] print:!text-[20pt]">
            {title}
          </h1>
          <p className="break-all type-mono-sm leading-5 text-muted-foreground">
            run {result.runId} · generated {formatUtcMinute(result.finishedAt)} · fund-origin-tracer
            (self-hosted)
          </p>
        </header>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div
            className="summary-card flex min-w-0 flex-col gap-1 rounded-sm border-2 p-2.5"
            data-risk={result.riskLevel}
            style={{ borderColor: `var(${risk.token})` }}
          >
            <p className="type-overline text-muted-foreground">RISK LEVEL</p>
            <p className="type-mono text-[18px] font-bold" style={{ color: `var(${risk.token})` }}>
              {risk.meter} {risk.label}
            </p>
            <p className="type-body-sm text-muted-foreground">{severityCounts}</p>
          </div>
          <div className="summary-card flex min-w-0 flex-col gap-1 rounded-sm border border-border-strong p-2.5">
            <p className="type-overline text-muted-foreground">EXCHANGE EXPOSURE</p>
            <p className="break-all type-mono text-[18px] font-semibold">
              {formatUsd(exposure.total)}
            </p>
            <p className="type-body-sm text-muted-foreground">
              direct + indirect · {exposure.entities}
              {exposure.minHops === null ? "" : ` · ≥${exposure.minHops} hops`}
            </p>
          </div>
          <div className="summary-card flex min-w-0 flex-col gap-1 rounded-sm border border-border-strong p-2.5">
            <p className="type-overline text-muted-foreground">TRACE SIZE</p>
            <p className="type-mono text-[18px] font-semibold">
              {result.graph.addresses.length} · {result.graph.edges.length}
            </p>
            <p className="type-body-sm text-muted-foreground">
              addresses · transfers, depth {result.stats.maxDepthReached} reached
            </p>
          </div>
        </div>

        <Section number={1} title="Flags">
          <FlagList result={result} />
        </Section>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 print:grid-cols-2 page-break">
          <Section number={2} title="Parameters and seeds" className="min-w-0">
            <MetaRows rows={parameterRows} />
            <ul className="space-y-1.5 type-mono-sm">
              {result.seeds.map((seed) => (
                <li key={seed.id} className="min-w-0 break-words">
                  <span className="text-muted-foreground">
                    seed {seed.id} ({seed.kind})
                  </span>
                  <br />
                  <ExplorerLink
                    chain={result.chain}
                    kind={seed.kind === "tx" ? "tx" : "address"}
                    value={seed.value}
                  >
                    <span className="address-full break-all">
                      {fullAddress(result.chain, seed.value)}
                    </span>
                  </ExplorerLink>
                </li>
              ))}
            </ul>
          </Section>
          <Section number={3} title="Data sources" className="min-w-0">
            <MetaRows rows={sources} />
            {result.warnings.length > 0 ? (
              <div className="space-y-1 type-body-sm">
                <p className="type-mono-sm text-muted-foreground">warnings</p>
                {result.warnings.map((warning) => (
                  <p key={`${warning.code}:${warning.message}`} className="break-words">
                    <strong>{warning.code}.</strong> {warning.message}
                  </p>
                ))}
              </div>
            ) : (
              <p className="type-body-sm text-muted-foreground">No warnings were recorded.</p>
            )}
          </Section>
        </div>

        <Section number={4} title="Exposure">
          <ExposureTables result={result} />
        </Section>
        <Section number={5} title="Exchange touchpoints" className="page-break">
          <TouchpointTable result={result} />
        </Section>
        <Section number={6} title="Linked wallets">
          <LinkedWalletTable result={result} />
        </Section>
        <Section number={7} title="Transfers" className="page-break">
          <TransfersTable result={result} limit={transferLimit} />
        </Section>

        <Section number={8} title="Methodology" className="page-break">
          <div className="space-y-2 type-body-sm leading-[1.55]">
            <p>
              The trace follows seed transactions or addresses in the selected direction. At each
              hop, candidate transfers are scored using asset match, amount proximity, time
              proximity and a dust penalty; the highest-scoring candidates are followed up to the
              configured branch limit.
            </p>
            <p>
              Branches stop at a labeled entity (unless tracing through entities is enabled), at the
              depth or edge limit, when no candidate remains, on a cycle, or after a fetch failure.
              The recorded stop reason and selected transfers are preserved in the result.
            </p>
          </div>
        </Section>
        <Section number={9} title="Limitations">
          <div className="space-y-2 type-body-sm leading-[1.55]">
            <p>
              Blockchain funds are fungible. A followed transfer is the best-scoring candidate under
              the configured heuristic, not proof that specific funds moved or that an address is
              controlled by a particular person.
            </p>
            <p>
              Explorer coverage, prices and labels may be incomplete or delayed. Unlabeled addresses
              are not necessarily safe, and a labeled entity does not establish ownership. Review
              the warnings and source timestamps above and verify findings independently.
            </p>
          </div>
        </Section>
        {notes?.trim() ? (
          <section className="space-y-2">
            <h2 className="type-heading">Notes</h2>
            <p className="whitespace-pre-wrap break-words type-body-sm leading-[1.55]">{notes}</p>
          </section>
        ) : null}
        <aside className="rounded-sm border border-border-strong bg-muted p-3 type-body-sm leading-[1.55]">
          <strong>Disclaimer.</strong> This report is generated from public blockchain data,
          third-party labels and the OFAC SDN list as of the timestamps above. It supports, and does
          not replace, an analyst’s judgment. It is not legal advice or a legal determination of
          ownership, sanctions status or wrongdoing.
        </aside>
      </div>
    </article>
  );
}

export { ReportDocument };
