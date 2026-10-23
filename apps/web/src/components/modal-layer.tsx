import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils.ts";

/** Open layers, bottom to top. Only the top one is interactive; everything beneath is inert. */
const openLayers: HTMLElement[] = [];

function syncInert() {
  const root = document.getElementById("root");
  if (root) root.inert = openLayers.length > 0;
  openLayers.forEach((layer, index) => {
    layer.inert = index < openLayers.length - 1;
  });
}

/**
 * Full-screen modal surface (phone detail sheet, full-graph overlay). While mounted it moves
 * focus in, makes the page and any lower layer inert, locks body scroll, closes on Escape (top
 * layer only) and restores focus to the previously focused element on unmount.
 */
export function ModalLayer({
  label,
  onClose,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    openLayers.push(layer);
    syncInert();
    layer.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openLayers[openLayers.length - 1] === layer) {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      openLayers.splice(openLayers.indexOf(layer), 1);
      syncInert();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={cn("outline-none", className)}
    >
      {children}
    </div>,
    document.body,
  );
}
