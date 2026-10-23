import { CATEGORY_META, STOP_TAGS } from "../../meta.ts";

const categories = Object.entries(CATEGORY_META) as [
  keyof typeof CATEGORY_META,
  (typeof CATEGORY_META)[keyof typeof CATEGORY_META],
][];
const tagItems = [
  { glyph: "SEED", text: "seed" },
  { glyph: STOP_TAGS.entity.code, text: "entity", title: STOP_TAGS.entity.text },
  { glyph: STOP_TAGS.max_depth.code, text: "max depth", title: STOP_TAGS.max_depth.text },
  {
    glyph: STOP_TAGS.no_candidates.code,
    text: "no candidates",
    title: STOP_TAGS.no_candidates.text,
  },
  { glyph: STOP_TAGS.cycle.code, text: "cycle", title: STOP_TAGS.cycle.text },
  { glyph: "⧉", text: "common source" },
  { glyph: "┄", text: "stopped" },
];

export function GraphLegend({ density }: { density: "chips" | "dots" | "compact" }) {
  return (
    <div className="relative flex items-center border-t border-border bg-card px-3 py-2 text-xs">
      <details className="group xl:hidden">
        <summary className="min-h-11 cursor-pointer list-none rounded-sm border border-border-strong px-3 py-1.5 font-medium md:min-h-8 [&::-webkit-details-marker]:hidden">
          Legend
        </summary>
        <div className="absolute bottom-full left-2 z-20 mb-1 max-w-[calc(100vw-1rem)] rounded-sm border border-border-strong bg-card p-3 shadow-popover">
          <LegendContents density={density} />
        </div>
      </details>
      <div className="hidden w-full xl:block">
        <LegendContents density={density} />
      </div>
    </div>
  );
}

function LegendContents({ density }: { density: "chips" | "dots" | "compact" }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        {categories.map(([category, meta]) => (
          <span
            key={category}
            className="inline-flex items-center gap-1 font-medium"
            style={{ color: `var(${meta.token})` }}
          >
            <span aria-hidden="true">{meta.glyph}</span>
            {meta.label}
          </span>
        ))}
      </div>
      <span className="hidden h-3.5 w-px bg-border-strong xl:block" />
      {density === "dots" ? (
        <span className="type-mono-sm text-muted-foreground">
          ■ labelled entity · ○ unlabeled · ┄ stopped · switch to Chips for addresses
        </span>
      ) : (
        <div className="flex flex-wrap gap-x-2.5 gap-y-1 type-mono-sm text-muted-foreground">
          {tagItems.map(({ glyph, text, title }) => (
            <span key={`${glyph}:${text}`} title={title}>
              {glyph} {text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
