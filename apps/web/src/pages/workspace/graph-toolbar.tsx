import { Button } from "@/components/ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group.tsx";
import type { RunPhase } from "../../run-state.ts";

export function GraphToolbar({
  phase,
  newCount,
  addressCount,
  pairCount,
  density,
  focused,
  canFocus,
  onDensityChange,
  onFitAll,
  onFocusSelection,
  onZoom100,
}: {
  phase: RunPhase;
  newCount: number;
  addressCount: number;
  pairCount: number;
  density: "chips" | "dots" | "compact";
  focused: boolean;
  canFocus: boolean;
  onDensityChange(density: "chips" | "dots"): void;
  onFitAll(): void;
  onFocusSelection(): void;
  onZoom100(): void;
}) {
  const live = phase === "running" || phase === "paused" || phase === "connecting";
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 text-xs">
      <div className="flex items-center overflow-hidden rounded-sm border border-border-strong">
        <Button type="button" variant="ghost" size="sm" className="rounded-none" onClick={onFitAll}>
          Fit all
        </Button>
        <Button
          type="button"
          variant={focused ? "secondary" : "ghost"}
          size="sm"
          className="rounded-none border-l border-border-strong"
          onClick={onFocusSelection}
          disabled={!canFocus}
          aria-pressed={focused}
        >
          Focus selection
        </Button>
        {density !== "dots" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-none border-l border-border-strong"
            onClick={onZoom100}
          >
            100%
          </Button>
        ) : null}
      </div>
      <ToggleGroup
        type="single"
        value={density === "dots" ? "dots" : "chips"}
        onValueChange={(value) => {
          if (value === "chips" || value === "dots") onDensityChange(value);
        }}
        aria-label="Graph node density"
      >
        <ToggleGroupItem value="chips" aria-label="Show graph chips" className="max-md:min-h-11">
          Chips
        </ToggleGroupItem>
        <ToggleGroupItem value="dots" aria-label="Show graph dots" className="max-md:min-h-11">
          Dots
        </ToggleGroupItem>
      </ToggleGroup>
      {phase === "running" ? (
        <span className="inline-flex items-center gap-1.5 rounded-xs bg-selection-muted px-2 py-1 type-mono-sm text-selection">
          <span className="size-1.5 rounded-full bg-selection" />
          streaming · {newCount} new
        </span>
      ) : null}
      <span className="min-w-0 text-muted-foreground">
        {addressCount} addresses{live ? " so far" : ""} · {pairCount} pairs
      </span>
      <span className="ml-auto type-mono-sm text-muted-foreground">money flows →</span>
    </div>
  );
}
