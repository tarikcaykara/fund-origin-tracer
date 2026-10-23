import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Pairs each item with a React key that stays unique when `base` repeats (`key`, `key#1`, …). */
export function withUniqueKeys<T>(
  items: readonly T[],
  base: (item: T) => string,
): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const id = base(item);
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    return { key: count === 0 ? id : `${id}#${count}`, item };
  });
}
