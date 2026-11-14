// A throwaway center for checking the merge flow in a browser. It never touches the real database or config:
//   node .scratch/core-quality/verify-server.ts <dbPath> <port> [fake|real]
// `fake` answers merge previews with a scripted model (default); `real` uses this machine's Claude Code login.
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createAdmin } from '../../src/server/admin-auth.ts';
import { ChangeFeed } from '../../src/server/change-feed.ts';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';
import { attachStream } from '../../src/server/stream.ts';
import { agentSdkRunner } from '../../src/understand/agent-sdk.ts';
import type { LlmRunner } from '../../src/understand/llm.ts';
import { disabledStatus } from '../../src/understand/status.ts';

const [dbPath, port, mode = 'fake'] = process.argv.slice(2);
if (!dbPath || !port) throw new Error('usage: verify-server.ts <dbPath> <port> [fake|real]');
const db = openDb(dbPath);
const config = { port: Number(port), dbPath, userToken: 'verify-user-token-0123456789', mcpToken: 'verify-mcp-token-0123456789', collectors: { 'gx10-090e': 'verify-collector-gx10-0123', 'mac-mini': 'verify-collector-mini-0123', 'never-seen': 'verify-collector-none-0123' } };
if (!db.prepare('SELECT 1 FROM admin_account').get()) await createAdmin(db, 'admin', 'verify-password-123456', new Date(), false);

const scripted: LlmRunner = async (call) => {
  await new Promise((r) => setTimeout(r, 2500));
  const ids = [...call.prompt.matchAll(/<chunk id="(\d+)">/g)].map((m) => Number(m[1]));
  return {
    ok: true,
    text: '',
    structured: {
      title: '演示：合并后的项目标题',
      summary: '（脚本模型）为看板用户把两处相关工作合成一个可验收的目标。',
      why: '（脚本模型）同一目标的工作分散在两个项目里，进度无法一起判断。',
      done_criteria: ['合并后的 session 都出现在目标项目', '来源项目按所选范围保留或标记为已合并'],
      unknowns: ['脚本模型没有读懂内容：这里只验证流程'],
      evidence: [{ field: 'summary', chunk_ids: ids.slice(0, 1) }, { field: 'done_criteria', chunk_ids: ids.slice(-1) }],
    },
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
    costUsd: 0,
    durationMs: 2500,
  };
};
const runner = mode === 'real' ? agentSdkRunner({ credential: () => ({ mode: 'login' }) }) : scripted;
const app = createApp(db, config, undefined, undefined, { webDir: fileURLToPath(new URL('../../dist/web', import.meta.url)), mergeLlm: { runner, model: () => 'claude-sonnet-5-5' } });
const feed = new ChangeFeed(db, { status: () => disabledStatus() });
const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => console.log(`verify server on http://127.0.0.1:${info.port} (${mode} model), db ${dbPath}`));
attachStream(server as Server, feed);
