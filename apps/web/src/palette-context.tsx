import type { ChainId } from "@fot/core/schema";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import type { PaletteRunData } from "@/palette.ts";
import type { Selection } from "@/selection.ts";

/** The open run, as the workspace registers it for the command palette. */
export interface PaletteRunSource extends PaletteRunData {
  chain: ChainId;
  select: (selection: Selection) => void;
}

type SetPaletteSource = Dispatch<SetStateAction<PaletteRunSource | null>>;

// Two contexts: the workspace only needs the setter, so run updates re-render palette consumers only.
const PaletteSourceContext = createContext<PaletteRunSource | null>(null);
const SetPaletteSourceContext = createContext<SetPaletteSource | null>(null);

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<PaletteRunSource | null>(null);
  return (
    <SetPaletteSourceContext.Provider value={setSource}>
      <PaletteSourceContext.Provider value={source}>{children}</PaletteSourceContext.Provider>
    </SetPaletteSourceContext.Provider>
  );
}

/** The open run's data for the palette, or `null` outside a run workspace. */
export function usePaletteSource(): PaletteRunSource | null {
  return useContext(PaletteSourceContext);
}

/** Registers `source` while the calling component is mounted; unmounting clears it. */
export function useRegisterPaletteSource(source: PaletteRunSource | null): void {
  const setSource = useContext(SetPaletteSourceContext);
  if (!setSource) throw new Error("useRegisterPaletteSource must be used within PaletteProvider.");
  useEffect(() => setSource(source), [setSource, source]);
  useEffect(() => () => setSource(null), [setSource]);
}
