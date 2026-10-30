import { expect, test } from 'vitest';
import { z } from 'zod';
import { agentSdkRunner } from '../../src/understand/agent-sdk.ts';
import { buildDigestPrompt, DIGEST_JSON_SCHEMA, DigestSchema } from '../../src/understand/digest.ts';
import type { ToolDef } from '../../src/understand/tool-def.ts';

// Real model calls. Off by default; run with HERDR_PM_LIVE=1 (uses the local Claude Code login or
// CLAUDE_CODE_OAUTH_TOKEN, and spends a tiny amount of subscription quota).
const live = process.env.HERDR_PM_LIVE === '1';
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

test.skipIf(!live)(
  'a tiny structured call returns structured output and usage',
  async () => {
    const r = await agentSdkRunner({ oauthToken })({
      role: 'digest',
      model: 'claude-haiku-5-5',
      system: '只输出要求的 JSON。',
      prompt: '返回 {"ok": true}',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      maxTurns: 3,
    });
    console.log('structured call result:', JSON.stringify(r));
    expect(r).toMatchObject({ ok: true, structured: { ok: true } });
    if (r.ok) {
      expect(r.usage.input_tokens + r.usage.cache_read_tokens).toBeGreaterThan(0);
      expect(r.usage.output_tokens).toBeGreaterThan(0);
    }
  },
  120_000,
);

test.skipIf(!live)(
  'a tool call reaches the ToolDef handler',
  async () => {
    const seen: { text: string }[] = [];
    const echo: ToolDef = {
      name: 'echo',
      description: 'Echoes the given text back. Call it exactly once.',
      input: { text: z.string() },
      handler: async (args: { text: string }) => {
        seen.push(args);
        return { text: `echoed: ${args.text}` };
      },
    };
    const r = await agentSdkRunner({ oauthToken })({
      role: 'curate',
      model: 'claude-haiku-5-5',
      system: 'You only use the tools you are given. After the tool returns, reply with the single word done.',
      prompt: 'Call the echo tool once with text "ping", then reply done.',
      tools: [echo],
      maxTurns: 5,
    });
    console.log('tool call result:', JSON.stringify(r));
    expect(r.ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toEqual({ text: 'ping' });
  },
  120_000,
);

test.skipIf(!live)(
  'a digest call returns output that matches DigestSchema',
  async () => {
    const text = '用户：帮我把 herdr-pm 的摘要员写完，先做窗口切分。\n助手：好的，我先写 nextWindow，再补测试。已完成窗口切分，测试通过。\n用户：下一步接调度器。';
    const { system, prompt } = buildDigestPrompt(
      {
        sessionKey: 'claude:live1111aaaabbbb',
        chunkIds: [1],
        staleChunkIds: [],
        text: `<chunk id="1">${text}</chunk>`,
        tsStart: '2026-10-29T10:00:00.000Z',
        tsEnd: '2026-10-29T10:10:00.000Z',
        backfill: false,
        totalChars: text.length,
      },
      {
        session: { agent_kind: 'claude', machine: 'laptop', cwd: '/work/herdr-pm', title: '写摘要员' },
        linkedBriefs: [],
        projectIndex: '- p_1 · 做 herdr-pm · 构建 · P1 · 把分散的 agent 工作收拢成看板',
      },
    );
    const r = await agentSdkRunner({ oauthToken })({
      role: 'digest',
      model: 'claude-haiku-5-5',
      system,
      prompt,
      outputSchema: DIGEST_JSON_SCHEMA,
      maxTurns: 3,
    });
    console.log('digest call result:', JSON.stringify(r));
    expect(r.ok).toBe(true);
    if (r.ok) expect(DigestSchema.safeParse(r.structured).success).toBe(true);
  },
  120_000,
);
