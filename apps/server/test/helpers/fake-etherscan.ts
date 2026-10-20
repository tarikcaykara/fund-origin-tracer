import type { Transport } from "@fot/core";

export const USDT_CONTRACT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const T0 = 1_700_000_000;

export const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
export const txHash = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

export interface FakeTransfer {
  tx: number;
  from: number;
  to: number;
  /** Whole USDT. */
  amount: number;
  ts: number;
}

/**
 * A linear chain (addresses start at 100, never the zero address): transfer k moves 1000 USDT from a(100+k) to a(99+k), one hour apart,
 * so a backward trace from tx 1 walks a1, a2, a3, ... one hop per transfer.
 */
export function chainOfTransfers(length: number): FakeTransfer[] {
  return Array.from({ length }, (_, i) => ({
    tx: i + 1,
    from: i + 101,
    to: i + 100,
    amount: 1000,
    ts: T0 + (length - i) * 3600,
  }));
}

const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const hex = (n: number | bigint) => `0x${n.toString(16)}`;

export interface FakeOptions {
  delayMs?: number;
  /** Called for every request, e.g. to count calls. */
  onRequest?: (url: URL) => void;
}

/** Minimal Etherscan V2 + OFAC stand-in over a list of canonical-USDT transfers. */
export function fakeTransport(transfers: FakeTransfer[], options: FakeOptions = {}): Transport {
  const ok = (result: unknown) => ({
    status: 200,
    body: JSON.stringify({ status: "1", message: "OK", result }),
  });
  const rpc = (result: unknown) => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
  });
  const empty = {
    status: 200,
    body: JSON.stringify({ status: "0", message: "No transactions found", result: [] }),
  };

  return async (req) => {
    const url = new URL(req.url);
    options.onRequest?.(url);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    if (url.hostname.includes("ofac.treas.gov")) return { status: 200, body: "<sdnList/>" };
    if (url.hostname !== "api.etherscan.io") return { status: 404, body: "" };

    const q = url.searchParams;
    const module = q.get("module");
    const action = q.get("action");
    const find = (hash: string | null) =>
      transfers.find((t) => txHash(t.tx) === hash?.toLowerCase());

    if (module === "proxy") {
      if (action === "eth_getTransactionByHash") {
        const t = find(q.get("txhash"));
        if (!t) return rpc(null);
        return rpc({
          hash: txHash(t.tx),
          blockNumber: hex(t.ts),
          from: addr(t.from),
          to: USDT_CONTRACT,
          value: "0x0",
        });
      }
      if (action === "eth_getTransactionReceipt") {
        const t = find(q.get("txhash"));
        if (!t) return rpc(null);
        return rpc({
          status: "0x1",
          logs: [
            {
              address: USDT_CONTRACT,
              topics: [TRANSFER_TOPIC, pad(addr(t.from)), pad(addr(t.to))],
              data: `0x${BigInt(t.amount * 1_000_000)
                .toString(16)
                .padStart(64, "0")}`,
            },
          ],
        });
      }
      if (action === "eth_getBlockByNumber") return rpc({ timestamp: q.get("tag") });
    }
    if (module === "block" && action === "getblocknobytime") return ok(q.get("timestamp"));

    if (module === "account") {
      if (action !== "tokentx" || q.get("txhash") || q.get("page") !== "1") return empty;
      const address = q.get("address")?.toLowerCase();
      const end = q.has("endblock") ? Number(q.get("endblock")) : Infinity;
      const start = q.has("startblock") ? Number(q.get("startblock")) : 0;
      const rows = transfers
        .filter((t) => addr(t.from) === address || addr(t.to) === address)
        .filter((t) => t.ts <= end && t.ts >= start)
        .sort((a, b) => (q.get("sort") === "asc" ? a.ts - b.ts : b.ts - a.ts))
        .map((t) => ({
          hash: txHash(t.tx),
          timeStamp: String(t.ts),
          blockNumber: String(t.ts),
          from: addr(t.from),
          to: addr(t.to),
          value: String(t.amount * 1_000_000),
          contractAddress: USDT_CONTRACT,
          tokenSymbol: "USDT",
          tokenName: "Tether USD",
          tokenDecimal: "6",
        }));
      return rows.length === 0 ? empty : ok(rows);
    }
    return { status: 404, body: "" };
  };
}
