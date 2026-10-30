import { expect, test } from 'vitest';
import { z } from 'zod';
import { buildQueryOptions, mapSdkMessages, TOOL_SERVER_NAME } from '../../src/understand/agent-sdk.ts';
import { isPausing, recordRun } from '../../src/understand/llm.ts';
import type { LlmCall, LlmErrorKind, LlmResult } from '../../src/understand/llm.ts';
import type { ToolDef } from '../../src/understand/tool-def.ts';
import { openDb } from '../../src/server/db.ts';
import type { DomainDeps } from '../../src/domain/types.ts';

const call: LlmCall = { role: 'digest', model: 'claude-haiku-5-5', system: 'sys', prompt: 'hi', maxTurns: 3 };
const deps: DomainDeps = { now: () => new Date('2026-10-30T08:00:00.000Z'), newId: (p) => `${p}_1` };

type RunRow = {
  role: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number;
  ok: number;
  error_kind: string | null;
  error: string | null;
  ts: string;
};

test('recordRun writes usage for a success and the error kind for a failure', () => {
  const db = openDb(':memory:');
  const success: LlmResult = {
    ok: true,
    text: 'done',
    structured: { a: 1 },
    usage: { input_tokens: 120, output_tokens: 34, cache_read_tokens: 56 },
    costUsd: 0.0123,
    durationMs: 2500,
  };
  recordRun(db, deps, call, success);
  recordRun(db, deps, { ...call, role: 'curate', model: 'claude-sonnet-5-5' }, { ok: false, kind: 'rate_limit', message: '429 slow down', durationMs: 80 });

  const rows = db.prepare('SELECT * FROM llm_runs ORDER BY id').all() as RunRow[];
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    role: 'digest',
    model: 'claude-haiku-5-5',
    input_tokens: 120,
    output_tokens: 34,
    cache_read_tokens: 56,
    cost_usd: 0.0123,
    duration_ms: 2500,
    ok: 1,
    error_kind: null,
    error: null,
    ts: '2026-10-30T08:00:00.000Z',
  });
  expect(rows[1]).toMatchObject({
    role: 'curate',
    model: 'claude-sonnet-5-5',
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    duration_ms: 80,
    ok: 0,
    error_kind: 'rate_limit',
    error: '429 slow down',
    ts: '2026-10-30T08:00:00.000Z',
  });
});

test('pausing kinds are rate_limit, overloaded and auth', () => {
  expect((['rate_limit', 'overloaded', 'auth'] as LlmErrorKind[]).every(isPausing)).toBe(true);
  expect(isPausing('bad_output')).toBe(false);
  expect(isPausing('other')).toBe(false);
});

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 };

function resultMsg(over: Record<string, unknown>): Record<string, unknown> {
  return { type: 'result', subtype: 'success', is_error: false, result: 'ok text', usage, total_cost_usd: 0.002, ...over };
}

test('mapSdkMessages maps a success result with text, structured output, usage and cost', () => {
  const r = mapSdkMessages([
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: {} },
    resultMsg({ structured_output: { ok: true } }),
  ]);
  expect(r).toEqual({
    ok: true,
    text: 'ok text',
    structured: { ok: true },
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 7 },
    costUsd: 0.002,
  });
});

test('mapSdkMessages turns a success without structured_output into bad_output only when structured output was expected', () => {
  const messages = [resultMsg({})];
  expect(mapSdkMessages(messages)).toMatchObject({ ok: true, structured: undefined });
  expect(mapSdkMessages(messages, { expectStructured: true })).toEqual({
    ok: false,
    kind: 'bad_output',
    message: 'the model returned no structured output',
  });
  expect(mapSdkMessages([resultMsg({ structured_output: { ok: false } })], { expectStructured: true })).toMatchObject({
    ok: true,
    structured: { ok: false },
  });
});

test('mapSdkMessages treats missing usage numbers as zero', () => {
  const r = mapSdkMessages([resultMsg({ usage: { input_tokens: 4 }, total_cost_usd: undefined })]);
  expect(r).toMatchObject({ ok: true, usage: { input_tokens: 4, output_tokens: 0, cache_read_tokens: 0 }, costUsd: 0 });
});

test('mapSdkMessages maps error_max_turns to other and joins the errors', () => {
  const r = mapSdkMessages([resultMsg({ subtype: 'error_max_turns', is_error: true, errors: ['too many turns', 'gave up'] })]);
  expect(r).toEqual({ ok: false, kind: 'other', message: 'too many turns; gave up' });
});

test('mapSdkMessages maps the other error subtypes to other', () => {
  for (const subtype of ['error_during_execution', 'error_max_budget_usd']) {
    const r = mapSdkMessages([resultMsg({ subtype, is_error: true, errors: ['boom'] })]);
    expect(r).toMatchObject({ ok: false, kind: 'other', message: 'boom' });
  }
});

test('mapSdkMessages maps error_max_structured_output_retries to bad_output', () => {
  const r = mapSdkMessages([resultMsg({ subtype: 'error_max_structured_output_retries', is_error: true, errors: ['schema mismatch'] })]);
  expect(r).toEqual({ ok: false, kind: 'bad_output', message: 'schema mismatch' });
});

test('mapSdkMessages maps api_error_status 429 / 529 / 401 / 403 on an errored result', () => {
  const kindFor = (status: number) => {
    const r = mapSdkMessages([resultMsg({ is_error: true, api_error_status: status, result: `api error ${status}` })]);
    return r.ok ? 'ok' : r.kind;
  };
  expect(kindFor(429)).toBe('rate_limit');
  expect(kindFor(529)).toBe('overloaded');
  expect(kindFor(401)).toBe('auth');
  expect(kindFor(403)).toBe('auth');
  expect(kindFor(500)).toBe('other');
  const r = mapSdkMessages([resultMsg({ is_error: true, api_error_status: 429, result: 'Rate limited' })]);
  expect(r).toMatchObject({ ok: false, message: 'Rate limited' });
});

test('mapSdkMessages lets api_error_status win over the error subtype', () => {
  const r = mapSdkMessages([resultMsg({ subtype: 'error_during_execution', is_error: true, api_error_status: 429, errors: ['429 from api'] })]);
  expect(r).toMatchObject({ ok: false, kind: 'rate_limit', message: '429 from api' });
});

test('mapSdkMessages maps an assistant error field when there is no result message', () => {
  const kindFor = (error: string) => {
    const r = mapSdkMessages([{ type: 'assistant', message: {}, error }]);
    return r.ok ? 'ok' : r.kind;
  };
  expect(kindFor('overloaded')).toBe('overloaded');
  expect(kindFor('rate_limit')).toBe('rate_limit');
  expect(kindFor('authentication_failed')).toBe('auth');
  expect(kindFor('oauth_org_not_allowed')).toBe('auth');
  expect(kindFor('billing_error')).toBe('auth');
  expect(kindFor('account_on_hold')).toBe('auth');
  expect(kindFor('verification_required')).toBe('auth');
  expect(kindFor('cloud_credential_error')).toBe('auth');
  expect(kindFor('model_not_found')).toBe('other');
  expect(kindFor('server_error')).toBe('other');
});

test('mapSdkMessages uses the assistant error when the errored result has no api_error_status', () => {
  const r = mapSdkMessages([
    { type: 'assistant', message: {}, error: 'overloaded' },
    resultMsg({ subtype: 'success', is_error: true, result: 'API Error: overloaded' }),
  ]);
  expect(r).toEqual({ ok: false, kind: 'overloaded', message: 'API Error: overloaded' });
});

test('mapSdkMessages reports a missing result message as other', () => {
  expect(mapSdkMessages([])).toMatchObject({ ok: false, kind: 'other' });
  expect(mapSdkMessages([{ type: 'system', subtype: 'init' }, { type: 'assistant', message: {} }])).toMatchObject({ ok: false, kind: 'other' });
});

test('mapSdkMessages ignores non-object junk', () => {
  expect(mapSdkMessages([null, 'x', 3, undefined, resultMsg({})])).toMatchObject({ ok: true });
});

// buildQueryOptions takes the SDK's tool() and createSdkMcpServer() as arguments, so the fixed options and the
// ToolDef conversion can be checked here without loading the real SDK.
function fakeSdk() {
  const tools: { name: string; description: string; shape: unknown; handler: (args: unknown) => Promise<unknown> }[] = [];
  const servers: { name: string; tools: unknown[] }[] = [];
  return {
    tools,
    servers,
    sdk: {
      tool: (name: string, description: string, shape: unknown, handler: (args: unknown) => Promise<unknown>) => {
        const t = { name, description, shape, handler };
        tools.push(t);
        return t;
      },
      createSdkMcpServer: (o: { name: string; tools: unknown[] }) => {
        servers.push(o);
        return { type: 'sdk', name: o.name, instance: {} };
      },
    },
  };
}

test('buildQueryOptions sets the fixed options and leaves out tools, schema and env when not asked for', () => {
  const { sdk, tools } = fakeSdk();
  const o = buildQueryOptions(sdk as never, call, {});
  expect(o).toMatchObject({
    model: 'claude-haiku-5-5',
    systemPrompt: 'sys',
    maxTurns: 3,
    tools: [],
    settingSources: [],
    persistSession: false,
  });
  expect(typeof o.cwd).toBe('string');
  expect(o).not.toHaveProperty('outputFormat');
  expect(o).not.toHaveProperty('mcpServers');
  expect(o).not.toHaveProperty('allowedTools');
  expect(tools).toHaveLength(0);
});

test('buildQueryOptions passes the oauth token on top of the process env, and the output schema as json_schema', () => {
  const { sdk } = fakeSdk();
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const o = buildQueryOptions(sdk as never, { ...call, outputSchema: schema }, { oauthToken: 'tok-123' });
  expect(o.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-123', PATH: process.env.PATH });
  expect(o.outputFormat).toEqual({ type: 'json_schema', schema });
});

test('buildQueryOptions never hands API credentials or other billing routes to the subprocess, with or without an oauth token', () => {
  // Any of these would make the call bill something other than the subscription.
  const scrubbed = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ];
  const names = [...scrubbed, 'HERDR_PM_TEST_KEEP'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of scrubbed) process.env[name] = `${name.toLowerCase()}-should-not-leak`;
  process.env.HERDR_PM_TEST_KEEP = 'kept';
  try {
    const { sdk } = fakeSdk();
    for (const oauthToken of [undefined, 'tok-123']) {
      const env = buildQueryOptions(sdk as never, call, { oauthToken }).env!;
      for (const name of scrubbed) expect(env, name).not.toHaveProperty(name);
      expect(env.HERDR_PM_TEST_KEEP).toBe('kept');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN);
    }
    // The real environment is left alone; only the copy handed to the SDK is stripped.
    for (const name of scrubbed) expect(process.env[name]).toBe(`${name.toLowerCase()}-should-not-leak`);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('buildQueryOptions turns ToolDefs into one in-process MCP server named pm and allows each tool', async () => {
  const { sdk, tools, servers } = fakeSdk();
  const seen: unknown[] = [];
  const echo: ToolDef = {
    name: 'echo',
    description: 'Echo the text back',
    input: { text: z.string() },
    handler: async (args) => {
      seen.push(args);
      return { text: `echo:${args.text}` };
    },
  };
  const fail: ToolDef = { name: 'fail', description: 'Always fails', input: {}, handler: async () => ({ text: 'nope', isError: true }) };
  const crash: ToolDef = {
    name: 'crash',
    description: 'Throws',
    input: {},
    handler: async () => {
      throw new Error('kaboom');
    },
  };
  const o = buildQueryOptions(sdk as never, { ...call, tools: [echo, fail, crash] }, {});

  expect(TOOL_SERVER_NAME).toBe('pm');
  expect(servers).toHaveLength(1);
  expect(servers[0]!.name).toBe('pm');
  expect(tools.map((t) => t.name)).toEqual(['echo', 'fail', 'crash']);
  expect(o.mcpServers).toEqual({ pm: { type: 'sdk', name: 'pm', instance: {} } });
  expect(o.allowedTools).toEqual(['mcp__pm__echo', 'mcp__pm__fail', 'mcp__pm__crash']);
  expect(tools[0]!.description).toBe('Echo the text back');
  expect(tools[0]!.shape).toBe(echo.input);

  await expect(tools[0]!.handler({ text: 'hi' })).resolves.toEqual({ content: [{ type: 'text', text: 'echo:hi' }], isError: undefined });
  expect(seen).toEqual([{ text: 'hi' }]);
  await expect(tools[1]!.handler({})).resolves.toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
  // A throwing handler comes back to the model as an error result rather than breaking the run.
  await expect(tools[2]!.handler({})).resolves.toEqual({ content: [{ type: 'text', text: 'tool crash failed: kaboom' }], isError: true });
});
