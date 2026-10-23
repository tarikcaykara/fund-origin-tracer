/** Zero-based page index from a `?page=` value; anything but a non-negative integer is page 0. */
export function parsePageParam(value: string | null): number {
  const page = Number.parseInt(value ?? "", 10);
  return Number.isFinite(page) && page > 0 ? page : 0;
}
