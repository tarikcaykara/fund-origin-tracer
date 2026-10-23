import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface CopyToast {
  title: string;
  subtitle?: string;
}

/** Copies `text` and reports the outcome with a toast. Resolves to whether the copy succeeded. */
export async function copyText(text: string, success: CopyToast): Promise<boolean> {
  try {
    // `navigator.clipboard` is undefined outside secure contexts, e.g. plain-http LAN previews.
    if (!navigator.clipboard) throw new Error("Clipboard API is unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    toast.error("Could not copy to clipboard", {
      description: window.isSecureContext
        ? "The browser refused clipboard access."
        : "Clipboard access needs HTTPS or localhost.",
    });
    return false;
  }
  toast.success(success.title, {
    duration: 4000,
    ...(success.subtitle ? { description: success.subtitle } : {}),
  });
  return true;
}

/** `copyText` plus a `copied` flag that resets after `resetMs` and clears its timer on unmount. */
export function useCopyText(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback(
    async (text: string, success: CopyToast) => {
      const ok = await copyText(text, success);
      window.clearTimeout(timer.current);
      setCopied(ok);
      if (ok) timer.current = window.setTimeout(() => setCopied(false), resetMs);
      return ok;
    },
    [resetMs],
  );
  return { copied, copy };
}
