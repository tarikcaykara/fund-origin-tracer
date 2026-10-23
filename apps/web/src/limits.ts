export interface RunLimits {
  maxDepth: number;
  maxBranches: number;
  maxEdges: number;
  minUsd: number;
}

function outOfRange(value: number, min: number, max: number): boolean {
  return !Number.isInteger(value) || value < min || value > max;
}

/** The first limit the server would reject, worded for the Start hint; `null` when all are valid. */
export function firstLimitError(limits: RunLimits): string | null {
  if (outOfRange(limits.maxDepth, 1, 50)) return "Max depth must be a whole number from 1 to 50.";
  if (outOfRange(limits.maxBranches, 1, 10))
    return "Max branches must be a whole number from 1 to 10.";
  if (outOfRange(limits.maxEdges, 10, 5000))
    return "Max edges must be a whole number from 10 to 5000.";
  if (!(limits.minUsd >= 0)) return "Min USD must be 0 or more.";
  return null;
}
