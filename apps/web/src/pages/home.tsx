import { CHAIN_IDS, isValidAddress } from "@fot/core/chains";
import type { ChainId, Direction } from "@fot/core/schema";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ApiError, api, type DemoScenario, type Health, type ScreenResult } from "@/api.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { chainName, directionName } from "@/format.ts";
import { useAsync } from "@/hooks/use-async.ts";
import { parseSeeds } from "@/seeds.ts";

const MAX_SEEDS = 20;

function missingKeyHint(chain: ChainId): string {
  return chain === "tron" ? "Add TRONSCAN_API_KEYS" : "Add ETHERSCAN_API_KEY";
}

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : "Unexpected error.";
}

function DemoCards({
  demos,
  prominent,
  onStart,
  busy,
}: {
  demos: DemoScenario[];
  prominent: boolean;
  onStart: (id: string) => void;
  busy: boolean;
}) {
  if (demos.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Recorded demos</h2>
      <p className="text-sm text-muted-foreground">
        {prominent
          ? "No API keys are configured, so live traces are unavailable. These recorded scenarios replay without keys."
          : "Replay a recorded scenario without spending any API quota."}
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {demos.map((d) => (
          <Card key={d.id} className={prominent ? "border-primary" : undefined}>
            <CardHeader>
              <CardTitle>{d.title}</CardTitle>
              <CardDescription>
                {chainName(d.chain)} · {directionName(d.direction)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">{d.description}</p>
              <Button disabled={busy} onClick={() => onStart(d.id)}>
                Run demo
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ScreenBox({ chain }: { chain: ChainId }) {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trimmed = address.trim();
  const valid = isValidAddress(chain, trimmed);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    try {
      setResult(await api.screen(chain, trimmed));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Screen an address</CardTitle>
        <CardDescription>
          Checks the {chainName(chain)} address against bundled labels, local labels and the OFAC
          SDN list. No explorer calls.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Address"
            aria-label="Address to screen"
            className="font-mono"
          />
          <Button type="submit" disabled={!valid}>
            Screen
          </Button>
        </form>
        {trimmed !== "" && !valid ? (
          <p className="text-sm text-destructive">Not a valid {chainName(chain)} address.</p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {result ? (
          <div className="space-y-2 text-sm">
            <p>
              {result.sanctioned ? (
                <Badge variant="destructive">On the OFAC SDN list</Badge>
              ) : (
                <Badge variant="secondary">Not on the OFAC SDN list</Badge>
              )}
            </p>
            {result.labels.length === 0 ? (
              <p className="text-muted-foreground">No labels.</p>
            ) : (
              <ul className="space-y-1">
                {result.labels.map((l) => (
                  <li key={`${l.origin}:${l.name}`} className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{l.category}</Badge>
                    <span>{l.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {l.origin} · {l.source}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={Number.isNaN(value) ? "" : value}
        min={min}
        {...(max === undefined ? {} : { max })}
        step={step ?? 1}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const health = useAsync<Health>(() => api.health(), []);
  const demos = useAsync<DemoScenario[]>(() => api.demos(), []);
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

  const chains = health.data?.chains;
  const anyReady = chains ? CHAIN_IDS.some((c) => chains[c] === "ready") : false;
  const demoOnly = health.data?.demoOnly ?? false;
  const liveReady = !demoOnly && chains?.[chain] === "ready";

  // Preselect the first ready chain once health arrives, unless the user already chose.
  useEffect(() => {
    if (!chains || chainTouched) return;
    const first = CHAIN_IDS.find((c) => chains[c] === "ready");
    if (first) setChain(first);
  }, [chains, chainTouched]);

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
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
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

  const demoCards = (
    <DemoCards
      demos={demos.data ?? []}
      prominent={health.data !== null && !anyReady}
      busy={busy}
      onStart={(id) => void start(() => api.createDemoRun(id))}
    />
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">New investigation</h1>
        <p className="text-sm text-muted-foreground">
          Trace where funds came from, or where they went, starting from transactions or addresses.
        </p>
      </div>

      {health.data !== null && !anyReady ? demoCards : null}

      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="chain">Chain</Label>
            <Select
              value={chain}
              onValueChange={(v) => {
                setChain(v as ChainId);
                setChainTouched(true);
              }}
            >
              <SelectTrigger id="chain" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHAIN_IDS.map((c) => {
                  const ready = chains?.[c] === "ready";
                  return (
                    <SelectItem key={c} value={c} disabled={chains !== undefined && !ready}>
                      {chainName(c)}
                      {chains !== undefined && !ready ? ` — ${missingKeyHint(c)}` : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Direction</legend>
            <div className="flex gap-2">
              {(["backward", "forward"] as const).map((d) => (
                <Button
                  key={d}
                  type="button"
                  variant={direction === d ? "default" : "outline"}
                  aria-pressed={direction === d}
                  onClick={() => setDirection(d)}
                >
                  {directionName(d)}
                </Button>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="seeds">Seeds (one per line, 1–{MAX_SEEDS})</Label>
          <Textarea
            id="seeds"
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            rows={5}
            placeholder="Transaction hashes or addresses"
            className="font-mono"
            aria-invalid={parsed.invalid.length > 0}
          />
          <p className="text-xs text-muted-foreground">
            {parsed.seeds.length} valid seed{parsed.seeds.length === 1 ? "" : "s"}
          </p>
          {parsed.invalid.length > 0 ? (
            <ul className="space-y-0.5 text-sm text-destructive" aria-label="Invalid seeds">
              {parsed.invalid.map((i) => (
                <li key={i.line}>
                  Line {i.line}: <span className="font-mono">{i.value}</span> is not a valid{" "}
                  {chainName(chain)} transaction hash or address
                </li>
              ))}
            </ul>
          ) : null}
          {parsed.seeds.length > MAX_SEEDS ? (
            <p className="text-sm text-destructive">At most {MAX_SEEDS} seeds are allowed.</p>
          ) : null}
        </div>

        <details className="rounded-md border p-4">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <NumberField
              id="maxDepth"
              label="Max depth (1–50)"
              value={maxDepth}
              onChange={setMaxDepth}
              min={1}
              max={50}
            />
            <NumberField
              id="maxBranches"
              label="Max branches (1–10)"
              value={maxBranches}
              onChange={setMaxBranches}
              min={1}
              max={10}
            />
            <NumberField
              id="maxEdges"
              label="Max edges (10–5000)"
              value={maxEdges}
              onChange={setMaxEdges}
              min={10}
              max={5000}
            />
            <NumberField
              id="minUsd"
              label="Min USD"
              value={minUsd}
              onChange={setMinUsd}
              min={0}
              step={0.01}
            />
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Checkbox
              id="through"
              checked={through}
              onCheckedChange={(v) => setThrough(v === true)}
            />
            <Label htmlFor="through">Trace through exchanges, DEXes and bridges</Label>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Checkbox
              id="followUnpriced"
              checked={followUnpriced}
              onCheckedChange={(v) => setFollowUnpriced(v === true)}
            />
            <Label htmlFor="followUnpriced">Follow tokens without a USD price</Label>
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canSubmit}>
            Start trace
          </Button>
          {health.data !== null && !liveReady ? (
            <span className="text-sm text-muted-foreground">
              {demoOnly
                ? "This instance only serves recorded demos."
                : `${chainName(chain)} is unavailable: ${missingKeyHint(chain)}.`}
            </span>
          ) : null}
        </div>
      </form>

      <ScreenBox chain={chain} />

      {health.data === null || anyReady ? demoCards : null}
    </div>
  );
}
