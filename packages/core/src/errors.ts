export type FotErrorCode =
  | "invalid_api_key"
  | "chain_requires_paid_plan"
  | "rate_limited"
  | "not_found"
  | "provider_error"
  | "network_error"
  | "fixture_miss"
  | "tx_failed";

export interface FotErrorOptions {
  retryable?: boolean;
  fatal?: boolean;
  retryAfterSec?: number;
  cause?: unknown;
}

export class FotError extends Error {
  readonly code: FotErrorCode;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly retryAfterSec: number | undefined;

  constructor(code: FotErrorCode, message: string, opts: FotErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "FotError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.fatal = opts.fatal ?? false;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export function isFotError(e: unknown): e is FotError {
  return e instanceof FotError;
}
