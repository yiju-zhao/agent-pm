import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { agentSdkRunner, DEFAULT_LLM_TIMEOUT_MS } from '../../src/understand/agent-sdk.ts';
import type { LlmCall } from '../../src/understand/llm.ts';

// The runner imports the SDK lazily, so a mock registered here replaces what it gets. Nothing in this file
// starts a real subprocess or calls a model.
const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  tool: vi.fn((name: string) => ({ name })),
  createSdkMcpServer: vi.fn((o: { name: string }) => ({ type: 'sdk', name: o.name })),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk);

const call: LlmCall = { role: 'digest', model: 'claude-haiku-5-5', system: 'sys', prompt: 'hi', maxTurns: 3 };
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 };
const successMsg = { type: 'result', subtype: 'success', is_error: false, result: 'fine', usage, total_cost_usd: 0.001 };

beforeEach(() => {
  sdk.query.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('the default timeout is ten minutes', () => {
  expect(DEFAULT_LLM_TIMEOUT_MS).toBe(600_000);
});

test('a result message gives ok:true with a measured duration', async () => {
  sdk.query.mockImplementation(async function* () {
    yield { type: 'system', subtype: 'init' };
    yield successMsg;
  });
  const r = await agentSdkRunner({})(call);
  expect(r).toMatchObject({ ok: true, text: 'fine', costUsd: 0.001, usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 7 } });
  expect(r.durationMs).toBeGreaterThanOrEqual(0);
});

test('query() throwing immediately comes back as other, not as an exception', async () => {
  sdk.query.mockImplementation(() => {
    throw new Error('spawn failed');
  });
  expect(await agentSdkRunner({})(call)).toMatchObject({ ok: false, kind: 'other', message: 'spawn failed' });
});

test('a stream that throws on its first read comes back as other', async () => {
  // eslint-disable-next-line require-yield
  sdk.query.mockImplementation(async function* () {
    throw new Error('process exited with code 1');
  });
  expect(await agentSdkRunner({})(call)).toMatchObject({ ok: false, kind: 'other', message: 'process exited with code 1' });
});

test('a throw after an assistant overloaded error keeps the overloaded kind', async () => {
  sdk.query.mockImplementation(async function* () {
    yield { type: 'assistant', message: {}, error: 'overloaded' };
    throw new Error('process exited with code 1');
  });
  expect(await agentSdkRunner({})(call)).toMatchObject({ ok: false, kind: 'overloaded', message: 'process exited with code 1' });
});

test('a throw after a success result still returns the result', async () => {
  sdk.query.mockImplementation(async function* () {
    yield successMsg;
    throw new Error('process exited with code 1');
  });
  expect(await agentSdkRunner({})(call)).toMatchObject({ ok: true, text: 'fine' });
});

test('a success without structured output is bad_output when the call has an output schema', async () => {
  sdk.query.mockImplementation(async function* () {
    yield successMsg;
  });
  const withSchema = await agentSdkRunner({})({ ...call, outputSchema: { type: 'object' } });
  expect(withSchema).toMatchObject({ ok: false, kind: 'bad_output' });
  expect(await agentSdkRunner({})(call)).toMatchObject({ ok: true });
});

test('a stream that never yields is aborted after timeoutMs and reported as other', async () => {
  let signal: AbortSignal | undefined;
  sdk.query.mockImplementation(({ options }: { options: { abortController: AbortController } }) => {
    signal = options.abortController.signal;
    // Ignores the abort on purpose: the runner must not depend on the SDK reacting to it.
    return (async function* () {
      await new Promise(() => {});
      yield successMsg;
    })();
  });
  const r = await agentSdkRunner({})({ ...call, timeoutMs: 30 });
  expect(r).toMatchObject({ ok: false, kind: 'other' });
  expect(r.ok === false && r.message).toMatch(/timed out after 30ms/);
  expect(signal?.aborted).toBe(true);
  expect(r.durationMs).toBeGreaterThanOrEqual(25);
});

test('a stream that fails because of the abort is reported as the timeout, not as the abort error', async () => {
  sdk.query.mockImplementation(({ options }: { options: { abortController: AbortController } }) => {
    const { signal } = options.abortController;
    return (async function* () {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted by caller'))));
      yield successMsg;
    })();
  });
  const r = await agentSdkRunner({})({ ...call, timeoutMs: 30 });
  expect(r).toMatchObject({ ok: false, kind: 'other' });
  expect(r.ok === false && r.message).toMatch(/timed out after 30ms/);
});

test('the timer is cleared when the call finishes in time', async () => {
  vi.useFakeTimers();
  sdk.query.mockImplementation(async function* () {
    yield successMsg;
  });
  expect(await agentSdkRunner({})({ ...call, timeoutMs: 5000 })).toMatchObject({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});
