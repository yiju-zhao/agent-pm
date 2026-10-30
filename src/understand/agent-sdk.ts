import { tmpdir } from 'node:os';
import type { LlmCall, LlmErrorKind, LlmOutcome, LlmRunner } from './llm.ts';

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
      return 'auth';
    default:
      return undefined;
  }
}

/**
 * Turns the SDK messages of one `query()` run into a result (everything but `durationMs`, which the runner measures).
 * Kept free of SDK imports so it can be unit tested with hand-written messages.
 */
export function mapSdkMessages(messages: unknown[]): LlmOutcome {
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
  const message =
    errors.length > 0
      ? errors.join('; ')
      : typeof result.result === 'string' && result.result !== ''
        ? result.result
        : `model run failed (${String(result.subtype)})`;
  const kind: LlmErrorKind =
    kindFromStatus(result.api_error_status) ??
    assistantKind ??
    (result.subtype === 'error_max_structured_output_retries' ? 'bad_output' : 'other');
  return { ok: false, kind, message };
}

/**
 * The fixed `query()` options for one call. `sdk` supplies `tool()` and `createSdkMcpServer()`;
 * it is a parameter so tests can check the conversion without loading the real SDK.
 */
export function buildQueryOptions(
  sdk: Pick<SdkModule, 'tool' | 'createSdkMcpServer'>,
  call: LlmCall,
  opts: { oauthToken?: string },
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
  // `env` replaces the subprocess environment, so it has to carry everything else too.
  if (opts.oauthToken) options.env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken };
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
 */
export function agentSdkRunner(opts: { oauthToken?: string }): LlmRunner {
  return async (call) => {
    const started = Date.now();
    const collected: unknown[] = [];
    let thrown: unknown;
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const q = sdk.query({ prompt: call.prompt, options: buildQueryOptions(sdk, call, opts) });
      for await (const message of q) {
        // Only these two kinds matter for the outcome; skip the rest instead of holding the whole transcript.
        if (message.type === 'result' || (message.type === 'assistant' && message.error !== undefined)) collected.push(message);
      }
    } catch (err) {
      thrown = err;
    }
    const mapped = mapSdkMessages(collected);
    const durationMs = Date.now() - started;
    if (thrown !== undefined && !collected.some((m) => isRecord(m) && m.type === 'result')) {
      // The call died before a result arrived; keep an error kind the assistant message already gave us.
      return { ok: false, kind: mapped.ok ? 'other' : mapped.kind, message: errMessage(thrown), durationMs };
    }
    return { ...mapped, durationMs };
  };
}
