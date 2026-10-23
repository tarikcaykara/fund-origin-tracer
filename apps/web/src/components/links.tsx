import type { AddressNode, ChainId } from "@fot/core/schema";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { addressUrl, fullAddress, shortAddress, shortHash, txUrl } from "@/format.ts";
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
  const [copied, setCopied] = useState(false);
  const timeout = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timeout.current), []);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(displayAddress);
      setCopied(true);
      window.clearTimeout(timeout.current);
      timeout.current = window.setTimeout(() => setCopied(false), 1500);
      toast("⧉ Copied to clipboard", { description: displayAddress, duration: 4000 });
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={displayAddress}
            onClick={() => void copyAddress()}
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
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open ${kind === "tx" ? "transaction" : "address"} in explorer`}
      className="inline-flex items-center gap-1 text-link underline-offset-2 hover:underline"
    >
      {children ?? <span aria-hidden="true">↗</span>}
    </a>
  );
}

export function AddressLink({
  chain,
  address,
  labels,
}: {
  chain: ChainId;
  address: string;
  labels?: LabelIndex | undefined;
}) {
  const node = labels?.get(address);
  const primary = node?.labels[0];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <AddressChip chain={chain} address={address} {...(primary ? { label: primary.name } : {})} />
      {primary ? (
        <Badge variant="outline" title={`${primary.category} · ${primary.source}`}>
          {primary.category}
        </Badge>
      ) : null}
      {node?.sanctioned ? <Badge variant="destructive">sanctioned</Badge> : null}
      <ExplorerLink chain={chain} kind="address" value={address} />
    </span>
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
