import type { DatabaseSync } from 'node:sqlite';
import type { DomainDeps } from '../domain/types.ts';
import type { ToolDef } from './tool-def.ts';

export type LlmRole = 'digest' | 'curate' | 'restage';

export type LlmCall = {
  role: LlmRole;
  model: string;
  system: string;
  prompt: string;
  /** JSON schema for structured output; the result lands in `LlmResult.structured`. */
  outputSchema?: Record<string, unknown>;
  tools?: ToolDef[];
  maxTurns: number;
  /** Abort the call and report it as `other` after this many ms; the runner's default applies when unset. */
  timeoutMs?: number;
};

/** `rate_limit`, `overloaded` and `auth` pause the scheduler; the rest only fail this one call. */
export type LlmErrorKind = 'rate_limit' | 'overloaded' | 'auth' | 'bad_output' | 'other';

export type LlmResult =
  | {
      ok: true;
      text: string;
      structured: unknown;
      usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number };
      costUsd: number;
      durationMs: number;
    }
  | { ok: false; kind: LlmErrorKind; message: string; durationMs: number };

/**
 * An `LlmResult` before the runner stamps `durationMs` on it. Written as a distributive omit because the plain
 * `Omit<LlmResult, 'durationMs'>` collapses the union and loses `kind` and `text`.
 */
export type LlmOutcome = OmitFromEach<LlmResult, 'durationMs'>;
type OmitFromEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Runs one model call. Never throws: failures come back as `ok: false`. */
export type LlmRunner = (call: LlmCall) => Promise<LlmResult>;

/** Writes one `llm_runs` row for a finished call, successful or not. */
export function recordRun(db: DatabaseSync, deps: DomainDeps, call: LlmCall, result: LlmResult): void {
  const ts = deps.now().toISOString();
  if (result.ok) {
    db.prepare(
      `INSERT INTO llm_runs (role, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, duration_ms, ok, error_kind, error, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?)`,
    ).run(
      call.role,
      call.model,
      result.usage.input_tokens,
      result.usage.output_tokens,
      result.usage.cache_read_tokens,
      result.costUsd,
      result.durationMs,
      ts,
    );
  } else {
    db.prepare(
      `INSERT INTO llm_runs (role, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, duration_ms, ok, error_kind, error, ts)
       VALUES (?, ?, NULL, NULL, NULL, NULL, ?, 0, ?, ?, ?)`,
    ).run(call.role, call.model, result.durationMs, result.kind, result.message, ts);
  }
}

/** True for errors that mean "stop calling the model for a while" (quota, overload, credentials). */
export function isPausing(kind: LlmErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'overloaded' || kind === 'auth';
}
