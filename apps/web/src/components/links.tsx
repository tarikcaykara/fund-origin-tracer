import type { AddressNode, ChainId } from "@fot/core/schema";
import { Badge } from "@/components/ui/badge.tsx";
import { addressUrl, shortAddress, shortHash, txUrl } from "@/format.ts";

export type LabelIndex = ReadonlyMap<string, AddressNode>;

export function indexAddresses(nodes: readonly AddressNode[] | undefined): LabelIndex {
  return new Map((nodes ?? []).map((n) => [n.address, n]));
}

export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-2"
    >
      {children}
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
      <a
        href={addressUrl(chain, address)}
        target="_blank"
        rel="noreferrer noopener"
        title={address}
        className="font-mono text-xs underline underline-offset-2"
      >
        {shortAddress(chain, address)}
      </a>
      {primary ? (
        <Badge variant="outline" title={`${primary.category} · ${primary.source}`}>
          {primary.name}
        </Badge>
      ) : null}
      {node?.sanctioned ? <Badge variant="destructive">sanctioned</Badge> : null}
    </span>
  );
}

export function TxLink({ chain, hash }: { chain: ChainId; hash: string }) {
  return (
    <a
      href={txUrl(chain, hash)}
      target="_blank"
      rel="noreferrer noopener"
      title={hash}
      className="font-mono text-xs underline underline-offset-2"
    >
      {shortHash(hash)}
    </a>
  );
}
