import type { AnalysisResult } from "@fot/core/schema";
import { TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { useBreakpoint } from "@/hooks/use-breakpoint.ts";

export function WorkspaceTabBar({
  edgeCount,
  result,
}: {
  edgeCount: number;
  result: AnalysisResult | null;
}) {
  const breakpoint = useBreakpoint();
  const phone = breakpoint === "phone";
  const desktop = breakpoint === "desktop";
  const tabs = [
    { value: "graph", label: phone ? "Path" : "Graph", count: null },
    { value: "transfers", label: "Transfers", count: edgeCount },
    { value: "exposure", label: "Exposure", count: null },
    {
      value: "linked",
      label: desktop ? "Linked wallets" : "Linked",
      count: result?.convergences.length ?? null,
    },
    {
      value: "touchpoints",
      label: desktop ? "Exchange touchpoints" : "Touchpoints",
      count: result?.exchangeTouchpoints.length ?? null,
    },
    { value: "flags", label: "Flags", count: result?.flags.length ?? null },
  ];

  return (
    <TabsList
      variant={phone ? "pills" : "underline"}
      className={
        phone
          ? "w-full justify-start gap-1 rounded-none border-0 px-3 py-2"
          : "w-full justify-start gap-0 px-2 xl:px-5"
      }
    >
      {tabs.map((tab) => (
        <TabsTrigger
          key={tab.value}
          value={tab.value}
          className={
            phone
              ? "min-h-11 flex-none rounded-full px-3 data-[state=active]:bg-foreground data-[state=active]:text-background"
              : "min-h-10 flex-none rounded-none px-2.5 xl:px-3.5"
          }
        >
          <span>{tab.label}</span>
          {tab.count !== null ? (
            <span className="type-mono-node opacity-75">{tab.count}</span>
          ) : null}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
