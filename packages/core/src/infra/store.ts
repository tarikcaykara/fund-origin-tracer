export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

export class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, { value: string; expiresAt: number }>();
  /** `now` is epoch milliseconds; injected so core never reads the clock itself. */
  constructor(private readonly now: () => number) {}

  async get(key: string): Promise<string | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.map.set(key, { value, expiresAt: this.now() + ttlSec * 1000 });
  }
}

export async function cacheKey(
  provider: string,
  chain: string,
  endpoint: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<string> {
  const sorted = Object.entries(params)
    .filter(([k, v]) => v !== undefined && k.toLowerCase() !== "apikey")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
  const data = new TextEncoder().encode(`${provider}|${chain}|${endpoint}|${sorted}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
