import { CHAIN_IDS, isValidAddress } from "@fot/core/chains";
import type { ChainId, Label as CoreLabel, Direction } from "@fot/core/schema";
import { ChevronDown } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import {
  ApiError,
  api,
  type DemoScenario,
  type Health,
  type RunSummary,
  type ScreenResult,
} from "@/api.ts";
import { CategoryTag, RiskMeter } from "@/components/badges.tsx";
import { Banner } from "@/components/banner.tsx";
import { ExternalLink } from "@/components/links.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group.tsx";
import { chainName, formatUtcMinute } from "@/format.ts";
import { useAsync } from "@/hooks/use-async.ts";
import { STATUS_META } from "@/meta.ts";
import { MAX_SEEDS, type ParsedSeeds, parseSeeds } from "@/seeds.ts";

const CONFIGURATION_URL = "https://github.com/tarikcaykara/fund-origin-tracer#configuration";

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Unexpected error.";
}

function keyName(chain: ChainId): string {
  return chain === "tron" ? "TRONSCAN_API_KEYS" : "ETHERSCAN_API_KEY";
}

function hasKey(health: Health | null, chain: ChainId): boolean {
  return health !== null && !health.demoOnly && health.chains[chain] === "ready";
}

function demoMeta(demo: DemoScenario): string {
  const direction = demo.direction === "backward" ? "← SOURCE OF FUNDS" : "DESTINATION OF FUNDS →";
  return `${chainName(demo.chain).toUpperCase()} · ${direction}`;
}

function DemoCards({
  demos,
  prominent,
  busy,
  onStart,
}: {
  demos: DemoScenario[];
  prominent: boolean;
  busy: boolean;
  onStart: (id: string) => void;
}) {
  if (demos.length === 0) return null;

  if (!prominent) {
    return (
      <Card>
        <CardHeader className="border-b border-border px-4 py-3">
          <CardTitle className="text-lg">Recorded demos</CardTitle>
          <CardDescription className="text-[13px] leading-relaxed">
            Replay a recorded scenario without spending any API quota.
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-0 px-4">
          {demos.map((demo) => (
            <div
              key={demo.id}
              className="flex min-w-0 items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium" title={demo.title}>
                  {demo.title}
                </p>
                <p className="mt-1 type-mono-node text-muted-foreground">{demoMeta(demo)}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onStart(demo.id)}
                className="shrink-0"
              >
                ▶ Run
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <section aria-labelledby="demo-heading" className="min-w-0 space-y-3">
      <div>
        <h2 id="demo-heading" className="type-overline text-muted-foreground">
          START WITH A RECORDED DEMO
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Replay a recorded scenario without spending any API quota.
        </p>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-3 xl:gap-4">
        {demos.map((demo) => (
          <Card key={demo.id} className="min-w-0 border-border-strong">
            <CardContent className="min-w-0 gap-3 p-4">
              <p className="type-mono-node text-muted-foreground">{demoMeta(demo)}</p>
              <h3 className="text-base font-semibold">{demo.title}</h3>
              <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted-foreground">
                {demo.description}
              </p>
              <Button type="button" size="lg" disabled={busy} onClick={() => onStart(demo.id)}>
                ▶ Run demo
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ChainField({
  chain,
  health,
  onChange,
}: {
  chain: ChainId;
  health: Health | null;
  onChange: (chain: ChainId) => void;
}) {
  const ready = hasKey(health, chain);
  const keyStatus = health === null ? "checking…" : ready ? "key ok" : "no key";

  return (
    <div className="min-w-0 space-y-1.5">
      <Label id="chain-label">Chain</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-labelledby="chain-label chain-current"
            className="h-9 w-full justify-between bg-muted px-3 data-[state=open]:border-selection data-[state=open]:ring-[3px] data-[state=open]:ring-selection-muted"
          >
            <span id="chain-current" className="flex min-w-0 items-center gap-2">
              <span className="truncate">{chainName(chain)}</span>
              <span
                className="type-mono-node"
                style={{ color: ready ? "var(--risk-low)" : "var(--risk-medium)" }}
              >
                {keyStatus}
              </span>
            </span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          {CHAIN_IDS.map((id) => {
            const chainReady = hasKey(health, id);
            const meta = health === null ? "checking…" : chainReady ? `${keyName(id)} ✓` : "no key";
            return (
              <DropdownMenuItem
                key={id}
                onSelect={() => onChange(id)}
                className="flex justify-between gap-4"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {chain === id ? (
                    <span aria-hidden="true" className="size-3.5 shrink-0">
                      ✓
                    </span>
                  ) : (
                    <span aria-hidden="true" className="size-3.5 shrink-0" />
                  )}
                  <span>{chainName(id)}</span>
                </span>
                <span
                  className="type-mono-node"
                  style={{ color: chainReady ? "var(--risk-low)" : "var(--risk-medium)" }}
                >
                  {meta}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SeedsEditor({
  value,
  chain,
  parsed,
  onChange,
  onShortcut,
}: {
  value: string;
  chain: ChainId;
  parsed: ParsedSeeds;
  onChange: (value: string) => void;
  onShortcut: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const rawLines = value.split(/\r?\n/);
  const resultByLine = new Map(parsed.lines.map((line) => [line.line, line]));
  const editorHeight = Math.min(286, Math.max(96, rawLines.length * 26 + 12));
  const countLabel =
    parsed.seeds.length === 0
      ? "0 valid seeds"
      : `${parsed.seeds.length} valid${parsed.invalid.length > 0 ? ` · ${parsed.invalid.length} invalid` : ""}`;
  const countColor =
    parsed.invalid.length > 0
      ? "var(--risk-high)"
      : parsed.seeds.length > 0
        ? "var(--risk-low)"
        : "var(--muted-foreground)";

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label htmlFor="seeds">Seeds</Label>
        <span id="seeds-help" className="text-xs text-muted-foreground">
          one per line, 1–{MAX_SEEDS} tx hashes or addresses
        </span>
        <span className="ml-auto type-mono-node" style={{ color: countColor }} aria-live="polite">
          {countLabel}
        </span>
      </div>
      <div
        className={`relative min-w-0 overflow-hidden rounded-md border bg-muted transition-[border-color,box-shadow] focus-within:ring-[3px] focus-within:ring-selection-muted ${
          parsed.invalid.length > 0
            ? "border-risk-high focus-within:border-risk-high"
            : parsed.seeds.length > 0
              ? "border-selection focus-within:border-selection"
              : "border-border-strong focus-within:border-selection"
        }`}
        style={{ height: editorHeight }}
      >
        <div
          ref={mirror}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden py-1.5"
        >
          {rawLines.map((line, index) => {
            const lineNumber = index + 1;
            const result = resultByLine.get(lineNumber);
            const trimmed = line.trim();
            const reason = result?.reason;
            const invalid = result !== undefined && !result.valid;
            const placeholder = value.length === 0 && index === 0;
            return (
              <div
                key={lineNumber}
                className={`grid h-[26px] min-w-0 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 border-l-2 px-2 font-mono text-[13px] leading-[26px] ${
                  invalid ? "border-risk-high bg-destructive-muted" : "border-transparent"
                }`}
              >
                <span
                  className="text-right text-faint-foreground"
                  style={invalid ? { color: "var(--risk-high)" } : undefined}
                >
                  {lineNumber}
                </span>
                <span
                  className={`min-w-0 truncate ${
                    placeholder ? "text-faint-foreground" : "text-foreground"
                  }`}
                  style={
                    invalid
                      ? {
                          color: "var(--risk-high)",
                          textDecorationLine: "underline",
                          textDecorationStyle: "wavy",
                          textDecorationColor: "var(--risk-high)",
                        }
                      : undefined
                  }
                  title={trimmed || undefined}
                >
                  {placeholder ? "Transaction hashes or addresses" : trimmed}
                </span>
                {result ? (
                  <span
                    className="max-w-[45vw] truncate text-right type-mono-node"
                    style={{ color: invalid ? "var(--risk-high)" : "var(--muted-foreground)" }}
                    title={invalid ? reason : undefined}
                  >
                    {invalid ? `✕ ${reason}` : `✓ ${result.kind === "tx" ? "tx" : "address"}`}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        <textarea
          id="seeds"
          aria-label={`Transaction hashes or addresses for ${chainName(chain)}`}
          aria-invalid={parsed.invalid.length > 0}
          aria-describedby="seeds-help seeds-errors"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onShortcut}
          onScroll={(event) => {
            if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop;
          }}
          className="absolute inset-0 z-10 h-full w-full resize-none overflow-auto border-0 bg-transparent py-1.5 pr-2 pl-[46px] font-mono text-[13px] leading-[26px] text-transparent caret-foreground outline-none selection:bg-selection-muted selection:text-transparent"
        />
      </div>
      <ul id="seeds-errors" className="sr-only" aria-label="Seed validation errors">
        {parsed.lines
          .filter((line) => !line.valid)
          .map((line) => (
            <li key={line.line}>
              Line {line.line}: {line.reason}.
            </li>
          ))}
      </ul>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        mono
        type="number"
        min={min}
        {...(max === undefined ? {} : { max })}
        step={step}
        value={Number.isNaN(value) ? "" : value}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className="h-8 max-md:h-11"
      />
    </div>
  );
}

function AdvancedLimits({
  maxDepth,
  maxBranches,
  maxEdges,
  minUsd,
  through,
  followUnpriced,
  setMaxDepth,
  setMaxBranches,
  setMaxEdges,
  setMinUsd,
  setThrough,
  setFollowUnpriced,
}: {
  maxDepth: number;
  maxBranches: number;
  maxEdges: number;
  minUsd: number;
  through: boolean;
  followUnpriced: boolean;
  setMaxDepth: (value: number) => void;
  setMaxBranches: (value: number) => void;
  setMaxEdges: (value: number) => void;
  setMinUsd: (value: number) => void;
  setThrough: (value: boolean) => void;
  setFollowUnpriced: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const summaryValue = (value: number) => (Number.isNaN(value) ? "—" : String(value));
  const summary = `depth ${summaryValue(maxDepth)} · branches ${summaryValue(maxBranches)} · edges ${summaryValue(maxEdges)} · min $${summaryValue(minUsd)}`;

  return (
    <section className="overflow-hidden rounded-md border border-border-strong">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="advanced-limits-content"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-10 max-md:min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-[13px] font-medium">
          <span aria-hidden="true" className="mr-2 text-muted-foreground">
            {open ? "▾" : "▸"}
          </span>
          Advanced limits
        </span>
        <span className="type-mono text-muted-foreground">{summary}</span>
      </button>
      {open ? (
        <div id="advanced-limits-content" className="space-y-4 border-t border-border p-3.5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <NumberField
              id="maxDepth"
              label="Max depth"
              value={maxDepth}
              min={1}
              max={50}
              onChange={setMaxDepth}
            />
            <NumberField
              id="maxBranches"
              label="Max branches"
              value={maxBranches}
              min={1}
              max={10}
              onChange={setMaxBranches}
            />
            <NumberField
              id="maxEdges"
              label="Max edges"
              value={maxEdges}
              min={10}
              max={5000}
              onChange={setMaxEdges}
            />
            <NumberField
              id="minUsd"
              label="Min USD"
              value={minUsd}
              min={0}
              step={0.01}
              onChange={setMinUsd}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex min-w-0 items-start gap-2.5">
              <Switch
                id="through"
                checked={through}
                onCheckedChange={setThrough}
                aria-label="Trace through entities"
                className="mt-0.5 max-md:after:-inset-y-[14px]"
              />
              <div className="min-w-0">
                <Label htmlFor="through" className="text-[13px] font-medium">
                  Trace through entities
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Off: stop at exchanges, bridges and other labelled entities.
                </p>
              </div>
            </div>
            <div className="flex min-w-0 items-start gap-2.5">
              <Switch
                id="followUnpriced"
                checked={followUnpriced}
                onCheckedChange={setFollowUnpriced}
                aria-label="Follow tokens without a USD price"
                className="mt-0.5 max-md:after:-inset-y-[14px]"
              />
              <div className="min-w-0">
                <Label htmlFor="followUnpriced" className="text-[13px] font-medium">
                  Follow tokens without a USD price
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Off: spam and airdrop tokens are not followed.
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ScreenBox({ chain, health }: { chain: ChainId; health: Health | null }) {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = address.trim();
  const valid = isValidAddress(chain, trimmed);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.screen(chain, trimmed));
    } catch (screenError) {
      setError(errorMessage(screenError));
    } finally {
      setBusy(false);
    }
  };

  const sanctionedLabel = (label: CoreLabel) =>
    label.category === "sanctioned" || label.origin === "ofac";
  const orderedLabels = result
    ? [...result.labels].sort(
        (left, right) => Number(sanctionedLabel(right)) - Number(sanctionedLabel(left)),
      )
    : [];
  const isSanctioned = result?.sanctioned ?? false;
  const fetchedAt = health?.ofacFetchedAt;

  return (
    <Card className="min-w-0">
      <CardHeader className="border-b border-border px-4 py-3">
        <CardTitle className="text-lg">Screen an address</CardTitle>
        <CardDescription className="text-[13px] leading-relaxed">
          Checks the {chainName(chain)} address against bundled and local labels and the OFAC SDN
          list.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 gap-3 px-4 py-4">
        <form onSubmit={(event) => void submit(event)} className="flex min-w-0 gap-2">
          <Input
            mono
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="Address"
            aria-label="Address to screen"
            aria-invalid={trimmed.length > 0 && !valid}
            aria-describedby="screen-address-error"
            className="min-w-0 flex-1 max-md:h-11"
          />
          <Button type="submit" variant="outline" disabled={!valid || busy} loading={busy}>
            Screen
          </Button>
        </form>
        <p id="screen-address-error" className="text-xs text-destructive" aria-live="polite">
          {trimmed.length > 0 && !valid ? `Not a valid ${chainName(chain)} address.` : ""}
        </p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {result ? (
          <div
            aria-live="polite"
            className={`min-w-0 space-y-2 rounded-sm border p-3 ${
              isSanctioned
                ? "border-[1.5px] border-risk-high bg-destructive-muted"
                : "border-border bg-transparent"
            }`}
          >
            {orderedLabels.length === 0 ? (
              <div>
                <p className="text-sm font-semibold">○ No label</p>
                <p className="mt-0.5 type-mono-node text-muted-foreground">
                  not in bundled or local labels
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {orderedLabels.map((label) => {
                  const category = label.category;
                  const origin = label.origin === "ofac" ? "OFAC SDN" : label.origin;
                  const meta = [category, label.entity, origin].filter(
                    (part, index, parts): part is string =>
                      part !== undefined && part !== label.name && parts.indexOf(part) === index,
                  );
                  return (
                    <li key={`${label.origin}:${label.category}:${label.name}`}>
                      <div className="flex min-w-0 items-center gap-2">
                        <CategoryTag category={category} label={label.name} />
                      </div>
                      <p className="mt-1 type-mono-node text-muted-foreground">
                        {meta.join(" · ")}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
            {isSanctioned ? (
              <div className="space-y-2">
                <span className="inline-flex rounded-sm border border-risk-high bg-risk-high px-1.5 py-0.5 type-mono-node font-semibold text-background">
                  ⊘ SDN MATCH · OFAC SDN
                </span>
                <p className="text-xs leading-relaxed text-foreground">
                  Do not process. Any trace that touches this address gets a high-severity sanctions
                  flag.
                </p>
              </div>
            ) : (
              <span className="inline-flex rounded-sm border border-risk-low px-1.5 py-0.5 type-mono-node font-semibold text-risk-low">
                ○ NO SDN MATCH
              </span>
            )}
            {fetchedAt ? (
              <p className="type-mono-node text-muted-foreground">
                OFAC SDN fetched {formatUtcMinute(fetchedAt)}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RecentCard({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) return null;

  return (
    <Card className="min-w-0">
      <CardHeader className="flex items-center justify-between border-b border-border px-4 py-3">
        <CardTitle className="text-lg">Recent</CardTitle>
        <Link to="/history" className="text-[13px] font-medium text-link hover:underline">
          History →
        </Link>
      </CardHeader>
      <CardContent className="gap-0 px-4">
        {runs.map((run) => {
          const direction = run.direction === "backward" ? "← source" : "destination →";
          const seedCount = `${run.seeds.length} seed${run.seeds.length === 1 ? "" : "s"}`;
          const status = STATUS_META[run.status].label.toLowerCase();
          return (
            <Link
              key={run.id}
              to={`/runs/${run.id}`}
              className="flex min-w-0 items-center justify-between gap-3 border-b border-border py-3 last:border-b-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium text-foreground">
                  {run.title ?? "Untitled investigation"}
                </span>
                <span className="mt-1 block truncate type-mono-node text-muted-foreground">
                  {chainName(run.chain)} · {direction} · {seedCount} · {status}
                </span>
              </span>
              <span className="shrink-0">
                <RiskMeter level={run.riskLevel} short />
              </span>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const health = useAsync<Health>(() => api.health(), []);
  const demos = useAsync<DemoScenario[]>(() => api.demos(), []);
  const recent = useAsync(() => api.listRuns({ limit: 3 }), []);
  const [chain, setChain] = useState<ChainId>("ethereum");
  const [chainTouched, setChainTouched] = useState(false);
  const [direction, setDirection] = useState<Direction>("backward");
  const [seedText, setSeedText] = useState("");
  const [maxDepth, setMaxDepth] = useState(10);
  const [maxBranches, setMaxBranches] = useState(3);
  const [maxEdges, setMaxEdges] = useState(200);
  const [minUsd, setMinUsd] = useState(0);
  const [through, setThrough] = useState(false);
  const [followUnpriced, setFollowUnpriced] = useState(false);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const healthData = health.data;
  const anyReady =
    healthData !== null &&
    !healthData.demoOnly &&
    CHAIN_IDS.some((id) => healthData.chains[id] === "ready");
  const demoOnly = healthData?.demoOnly ?? false;
  const liveReady = hasKey(healthData, chain);

  useEffect(() => {
    if (!healthData || chainTouched || demoOnly) return;
    const firstReady = CHAIN_IDS.find((id) => healthData.chains[id] === "ready");
    if (firstReady) setChain(firstReady);
  }, [healthData, chainTouched, demoOnly]);

  const parsed = useMemo(() => parseSeeds(seedText, chain), [seedText, chain]);
  const limitsValid =
    maxDepth >= 1 &&
    maxDepth <= 50 &&
    maxBranches >= 1 &&
    maxBranches <= 10 &&
    maxEdges >= 10 &&
    maxEdges <= 5000 &&
    minUsd >= 0;
  const canSubmit =
    liveReady &&
    !busy &&
    limitsValid &&
    parsed.invalid.length === 0 &&
    parsed.seeds.length >= 1 &&
    parsed.seeds.length <= MAX_SEEDS;

  const start = async (launch: () => Promise<{ runId: string }>) => {
    setBusy(true);
    try {
      const { runId } = await launch();
      navigate(`/runs/${runId}`);
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    void start(() =>
      api.createRun({
        chain,
        direction,
        seeds: parsed.seeds,
        maxDepth,
        maxBranches,
        maxEdges,
        minUsd,
        traceThroughEntities: through,
        followUnpriced,
      }),
    );
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || !canSubmit) return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  };

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcut = isMac ? "⌘↵" : "Ctrl↵";
  let startHint: string;
  if (parsed.seeds.length === 0) startHint = "Add at least one seed.";
  else if (parsed.invalid.length > 0) {
    const invalidLines = parsed.invalid.map((seed) => seed.line);
    const linePhrase =
      invalidLines.length === 1
        ? `line ${invalidLines[0]}`
        : `lines ${invalidLines.slice(0, -1).join(", ")} and ${invalidLines.at(-1)}`;
    startHint = `Fix ${linePhrase} to start.`;
  } else if (!liveReady) {
    startHint = demoOnly
      ? "Live traces are disabled on this instance; run a recorded demo."
      : `Add ${keyName(chain)} or run a recorded demo.`;
  } else {
    startHint = `${parsed.seeds.length} ${parsed.seeds.length === 1 ? "seed" : "seeds"} · ${chainName(chain)} · ${direction}`;
  }

  const demoItems = demos.data ?? [];
  const prominentDemos = healthData !== null && (!anyReady || demoOnly);
  const runDemo = (id: string) => void start(() => api.createDemoRun(id));

  return (
    <div className="flex min-w-0 flex-col">
      {healthData && (!anyReady || demoOnly) ? (
        <Banner
          tone="warning"
          tag={demoOnly ? "DEMO-ONLY INSTANCE" : "NO EXPLORER API KEY"}
          className="rounded-none border-x-0 border-t-0 px-4 xl:px-5"
          actions={
            <ExternalLink href={CONFIGURATION_URL}>
              <span className="font-medium">Setup guide</span>
            </ExternalLink>
          }
        >
          {demoOnly ? "Live traces are disabled on this instance. " : null}
          Ethereum, Polygon and Arbitrum need{" "}
          <code className="rounded-xs bg-muted px-1 type-mono-node">ETHERSCAN_API_KEY</code>. TRON
          needs <code className="rounded-xs bg-muted px-1 type-mono-node">TRONSCAN_API_KEYS</code>.
          Recorded demos run offline.
        </Banner>
      ) : null}

      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 xl:gap-6 xl:px-8 xl:pb-8">
        {prominentDemos ? (
          <div className="order-2 min-w-0 md:order-1">
            <DemoCards demos={demoItems} prominent busy={busy} onStart={runDemo} />
          </div>
        ) : null}

        <div className="order-1 grid min-w-0 grid-cols-1 items-start gap-4 md:order-2 xl:grid-cols-[minmax(0,1fr)_420px] xl:gap-6">
          <Card className="min-w-0">
            <CardHeader className="border-b border-border px-5 py-4">
              <CardTitle className="text-xl font-semibold">New investigation</CardTitle>
              <CardDescription className="text-[13px] leading-relaxed">
                Trace where funds came from, or where they went, starting from transactions or
                addresses.
              </CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 gap-5 p-5">
              <form ref={formRef} onSubmit={submit} className="min-w-0 space-y-5">
                <div className="grid min-w-0 gap-5 xl:grid-cols-[260px_minmax(0,1fr)]">
                  <ChainField
                    chain={chain}
                    health={healthData}
                    onChange={(nextChain) => {
                      setChain(nextChain);
                      setChainTouched(true);
                    }}
                  />
                  <fieldset className="min-w-0 space-y-1.5">
                    <legend className="mb-1.5 text-sm font-medium">Direction</legend>
                    <ToggleGroup
                      type="single"
                      value={direction}
                      onValueChange={(value) => {
                        if (value) setDirection(value as Direction);
                      }}
                      aria-label="Trace direction"
                      className="w-full"
                    >
                      <ToggleGroupItem
                        value="backward"
                        aria-label="Source of funds"
                        className="min-h-9 max-md:min-h-11 flex-1"
                      >
                        ← Source of funds
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value="forward"
                        aria-label="Destination of funds"
                        className="min-h-9 max-md:min-h-11 flex-1"
                      >
                        Destination of funds →
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </fieldset>
                </div>

                <SeedsEditor
                  value={seedText}
                  chain={chain}
                  parsed={parsed}
                  onChange={setSeedText}
                  onShortcut={handleEditorKeyDown}
                />

                <AdvancedLimits
                  maxDepth={maxDepth}
                  maxBranches={maxBranches}
                  maxEdges={maxEdges}
                  minUsd={minUsd}
                  through={through}
                  followUnpriced={followUnpriced}
                  setMaxDepth={setMaxDepth}
                  setMaxBranches={setMaxBranches}
                  setMaxEdges={setMaxEdges}
                  setMinUsd={setMinUsd}
                  setThrough={setThrough}
                  setFollowUnpriced={setFollowUnpriced}
                />

                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  <Button type="submit" size="lg" disabled={!canSubmit} loading={busy}>
                    <span>Start trace</span>
                    <kbd className="ml-2 type-mono-node opacity-70">{shortcut}</kbd>
                  </Button>
                  <p
                    className={`min-w-0 text-xs ${parsed.invalid.length > 0 ? "text-risk-high" : "text-muted-foreground"}`}
                    aria-live="polite"
                  >
                    {startHint}
                  </p>
                </div>
              </form>
            </CardContent>
          </Card>

          <aside className="grid min-w-0 content-start gap-4">
            <ScreenBox chain={chain} health={healthData} />
            <RecentCard runs={recent.data?.items ?? []} />
            {!prominentDemos ? (
              <DemoCards demos={demoItems} prominent={false} busy={busy} onStart={runDemo} />
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
