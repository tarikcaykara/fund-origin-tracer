import type { AddressNode, ChainId } from "@fot/core/schema";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { addressUrl, fullAddress, shortAddress, shortHash, txUrl } from "@/format.ts";
import { useCopyText } from "@/lib/clipboard.ts";
import { cn } from "@/lib/utils.ts";

export type LabelIndex = ReadonlyMap<string, AddressNode>;

export function indexAddresses(nodes: readonly AddressNode[] | undefined): LabelIndex {
  return new Map((nodes ?? []).map((node) => [node.address, node]));
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-link underline underline-offset-2"
    >
      {children}
    </a>
  );
}

export function AddressChip({
  chain,
  address,
  label,
  full = false,
}: {
  chain: ChainId;
  address: string;
  label?: string;
  full?: boolean;
}) {
  const displayAddress = fullAddress(chain, address);
  const { copied, copy } = useCopyText();

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Copy ${displayAddress}`}
            onClick={() =>
              void copy(displayAddress, {
                title: "⧉ Copied to clipboard",
                subtitle: displayAddress,
              })
            }
            className={cn(
              "address rounded-sm px-0.5 text-foreground hover:bg-muted",
              copied && "bg-success-muted px-1 text-success [text-decoration:none]",
              full && "whitespace-normal break-all",
            )}
          >
            {copied ? "✓ copied" : full ? displayAddress : shortAddress(chain, displayAddress)}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm break-all type-mono-node">
          {displayAddress} · click to copy
        </TooltipContent>
      </Tooltip>
      {label ? (
        <span className="max-w-40 truncate text-foreground" title={label}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Explorer link. With text `children` the visible text is the accessible name; without them the
 * link renders an arrow glyph and carries an `aria-label` instead.
 */
export function ExplorerLink({
  chain,
  kind,
  value,
  children,
}: {
  chain: ChainId;
  kind: "address" | "tx";
  value: string;
  children?: ReactNode;
}) {
  const href = kind === "address" ? addressUrl(chain, value) : txUrl(chain, value);
  const noun = kind === "tx" ? "transaction" : "address";
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={value}
      {...(children === undefined ? { "aria-label": `Open ${noun} ${value} in explorer` } : {})}
      className="inline-flex items-center gap-1 text-link underline-offset-2 hover:underline"
    >
      {children ?? <span aria-hidden="true">↗</span>}
    </a>
  );
}

export function TxLink({ chain, hash }: { chain: ChainId; hash: string }) {
  return (
    <ExplorerLink chain={chain} kind="tx" value={hash}>
      <span className="font-mono text-xs">{shortHash(hash)}</span>
      <span aria-hidden="true">↗</span>
    </ExplorerLink>
  );
}
