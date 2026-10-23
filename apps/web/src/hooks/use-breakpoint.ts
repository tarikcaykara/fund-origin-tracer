import { useEffect, useState } from "react";

export type Breakpoint = "phone" | "tablet" | "desktop";

export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() => {
    if (window.matchMedia("(width >= 80rem)").matches) return "desktop";
    return window.matchMedia("(width >= 48rem)").matches ? "tablet" : "phone";
  });

  useEffect(() => {
    const tabletQuery = window.matchMedia("(width >= 48rem)");
    const desktopQuery = window.matchMedia("(width >= 80rem)");
    const update = () => {
      setBreakpoint(desktopQuery.matches ? "desktop" : tabletQuery.matches ? "tablet" : "phone");
    };

    update();
    tabletQuery.addEventListener("change", update);
    desktopQuery.addEventListener("change", update);
    return () => {
      tabletQuery.removeEventListener("change", update);
      desktopQuery.removeEventListener("change", update);
    };
  }, []);

  return breakpoint;
}
