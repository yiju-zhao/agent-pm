import { tmpdir } from 'node:os';
import type { Credential } from '../server/settings.ts';
import type { LlmCall, LlmErrorKind, LlmOutcome, LlmRunner } from './llm.ts';

/** How long one call may run before the runner aborts it, unless `LlmCall.timeoutMs` says otherwise. */
export const DEFAULT_LLM_TIMEOUT_MS = 600_000;

/**
 * How often Claude Code lets the model retry a StructuredOutput call that failed validation (its
 * `MAX_STRUCTURED_OUTPUT_RETRIES` default) before it ends the run as `error_max_structured_output_retries`. Each attempt
 * is a turn, so a call with an output schema needs `maxTurns` of at least one more than this for that limit, not the
 * turn cap, to be what ends a run that keeps producing bad output.
 */
export const SDK_STRUCTURED_OUTPUT_RETRIES = 5;

/** Name of the in-process MCP server that carries a call's tools; the model sees them as `mcp__pm__<name>`. */
export const TOOL_SERVER_NAME = 'pm';

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
type SdkQueryOptions = NonNullable<Parameters<SdkModule['query']>[0]['options']>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** HTTP status the API answered with (carried on the result message) to error kind. */
function kindFromStatus(status: unknown): LlmErrorKind | undefined {
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status === 401 || status === 403) return 'auth';
  return undefined;
}

/** `error` field of an assistant message to error kind; other values (server_error, ...) are not classified here. */
function kindFromAssistantError(error: unknown): LlmErrorKind | undefined {
  switch (error) {
    case 'rate_limit':
      return 'rate_limit';
    case 'overloaded':
      return 'overloaded';
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'billing_error':
    case 'account_on_hold':
    case 'verification_required':
    case 'cloud_credential_error':
      return 'auth';
    default:
      return undefined;
  }
}

/**
 * Turns the SDK messages of one `query()` run into a result (everything but `durationMs`, which the runner measures).
 * Kept free of SDK imports so it can be unit tested with hand-written messages.
 * With `expectStructured` (the call carried an output schema) a success without `structured_output` is `bad_output`, and
 * so is running out of turns.
 */
export function mapSdkMessages(messages: unknown[], opts: { expectStructured?: boolean } = {}): LlmOutcome {
  let result: Record<string, unknown> | undefined;
  let assistantKind: LlmErrorKind | undefined;
  for (const m of messages) {
    if (!isRecord(m)) continue;
    if (m.type === 'result') result = m;
    else if (m.type === 'assistant' && assistantKind === undefined) assistantKind = kindFromAssistantError(m.error);
  }

  if (result === undefined) {
    return { ok: false, kind: assistantKind ?? 'other', message: 'the model run ended without a result message' };
  }

  if (result.subtype === 'success' && result.is_error !== true) {
    if (opts.expectStructured && result.structured_output === undefined) {
      return { ok: false, kind: 'bad_output', message: 'the model returned no structured output' };
    }
    const u = isRecord(result.usage) ? result.usage : {};
    return {
      ok: true,
      text: typeof result.result === 'string' ? result.result : '',
      structured: result.structured_output,
      usage: { input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_tokens: num(u.cache_read_input_tokens) },
      costUsd: num(result.total_cost_usd),
    };
  }

  const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === 'string') : [];
  let message =
    errors.length > 0
      ? errors.join('; ')
      : typeof result.result === 'string' && result.result !== ''
        ? result.result
        : `model run failed (${String(result.subtype)})`;
  // With an output schema the turns go to StructuredOutput attempts, so running out of them means none was valid.
  const structuredTurnsOut = opts.expectStructured === true && result.subtype === 'error_max_turns';
  if (structuredTurnsOut) message += ' (no valid structured output within the turn limit)';
  const kind: LlmErrorKind =
    kindFromStatus(result.api_error_status) ??
    assistantKind ??
    (result.subtype === 'error_max_structured_output_retries' || structuredTurnsOut ? 'bad_output' : 'other');
  return { ok: false, kind, message };
}

/** Environment variables that route a call away from the subscription (an API key, another endpoint, a cloud provider). */
const NON_SUBSCRIPTION_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/**
 * The fixed `query()` options for one call. `sdk` supplies `tool()` and `createSdkMcpServer()`;
 * it is a parameter so tests can check the conversion without loading the real SDK.
 */
export function buildQueryOptions(
  sdk: Pick<SdkModule, 'tool' | 'createSdkMcpServer'>,
  call: LlmCall,
  opts: RunnerAuth,
): SdkQueryOptions {
  const options: SdkQueryOptions = {
    model: call.model,
    systemPrompt: call.system,
    maxTurns: call.maxTurns,
    // No built-in tools (Bash, Read, ...): the model only gets what this call hands it.
    tools: [],
    // Ignore the user's and project's Claude Code settings, skills and CLAUDE.md files.
    settingSources: [],
    persistSession: false,
    cwd: tmpdir(),
  };
  // `env` replaces the subprocess environment, so it has to carry everything else too. API credentials, a custom
  // endpoint and the cloud-provider switches are always stripped, so an inherited setting can never decide what a call
  // bills: only the credential chosen here does. An API key (chosen explicitly in the settings) bills that API
  // account; everything else bills the Claude subscription.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of NON_SUBSCRIPTION_ENV) delete env[name];
  const credential = opts.credential?.() ?? (opts.oauthToken ? { mode: 'oauth_token' as const, token: opts.oauthToken } : { mode: 'login' as const });
  if (credential.mode === 'oauth_token') env.CLAUDE_CODE_OAUTH_TOKEN = credential.token;
  if (credential.mode === 'api_key') {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    env.ANTHROPIC_API_KEY = credential.key;
  }
  options.env = env;
  if (call.outputSchema) options.outputFormat = { type: 'json_schema', schema: call.outputSchema };
  if (call.tools && call.tools.length > 0) {
    const sdkTools = call.tools.map((def) =>
      sdk.tool(def.name, def.description, def.input, async (args) => {
        try {
          const out = await def.handler(args);
          return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError };
        } catch (err) {
          // A throwing handler is reported to the model as a failed tool call instead of breaking the run.
          return { content: [{ type: 'text' as const, text: `tool ${def.name} failed: ${errMessage(err)}` }], isError: true };
        }
      }),
    );
    options.mcpServers = { [TOOL_SERVER_NAME]: sdk.createSdkMcpServer({ name: TOOL_SERVER_NAME, tools: sdkTools }) };
    options.allowedTools = call.tools.map((t) => `mcp__${TOOL_SERVER_NAME}__${t.name}`);
  }
  return options;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs calls through the Claude Agent SDK, billed to the Claude subscription. Without `oauthToken` the SDK uses
 * the local Claude Code login. The SDK is imported inside the function: the single-file collector binary is built
 * with it as an external, so nothing at module top level may load it.
 *
 * A call that runs longer than `call.timeoutMs` (default `DEFAULT_LLM_TIMEOUT_MS`) is aborted and comes back as
 * `other`, so a hung subprocess cannot block the scheduler's one-call-at-a-time slot forever.
 */
/**
 * Which credential a call runs under. `credential` is read at every call (the settings may change it while the center
 * runs); without it, `oauthToken` or else the local Claude Code login.
 */
export type RunnerAuth = { oauthToken?: string; credential?: () => Credential };

export function agentSdkRunner(opts: RunnerAuth): LlmRunner {
  return async (call) => {
    const started = Date.now();
    const timeoutMs = call.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    const controller = new AbortController();
    const collected: unknown[] = [];
    let thrown: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const drain = async (): Promise<void> => {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const options = buildQueryOptions(sdk, call, opts);
      options.abortController = controller;
      for await (const message of sdk.query({ prompt: call.prompt, options })) {
        // Only these two kinds matter for the outcome; skip the rest instead of holding the whole transcript.
        if (message.type === 'result' || (message.type === 'assistant' && message.error !== undefined)) collected.push(message);
      }
    };
    // The abort tells the SDK to kill its subprocess; racing against the timer as well means a stream that does
    // not react to the abort still cannot keep this call hanging.
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, timeoutMs);
    });
    const draining = drain();
    draining.catch(() => {}); // a run that loses the race may still fail later; that must not become unhandled

    let timedOut = false;
    try {
      timedOut = (await Promise.race([draining, timeout])) === 'timeout';
    } catch (err) {
      thrown = err;
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - started;
    const hasResult = collected.some((m) => isRecord(m) && m.type === 'result');
    if (timedOut && !hasResult) {
      return { ok: false, kind: 'other', message: `the model call timed out after ${timeoutMs}ms`, durationMs };
    }
    const mapped = mapSdkMessages(collected, { expectStructured: call.outputSchema !== undefined });
    if (thrown !== undefined && !hasResult) {
      // The call died before a result arrived; keep an error kind the assistant message already gave us.
      return { ok: false, kind: mapped.ok ? 'other' : mapped.kind, message: errMessage(thrown), durationMs };
    }
    return { ...mapped, durationMs };
  };
}
