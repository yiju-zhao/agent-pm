// Fixed quality cases for the merge draft, run against the real model on synthetic sessions (no real data):
//   node .scratch/core-quality/quality-cases.ts [model]
// Each case states what a good draft must and must not contain, checked mechanically, and prints the draft so a person
// can judge the wording. A passing run is evidence for these cases only, not a general quality claim.
import { execute } from '../../src/domain/execute.ts';
import { resolveMergeScope } from '../../src/domain/merge.ts';
import { defaultDeps } from '../../src/domain/types.ts';
import { openDb } from '../../src/server/db.ts';
import { agentSdkRunner } from '../../src/understand/agent-sdk.ts';
import { draftMerge } from '../../src/understand/merge-preview.ts';

const model = process.argv[2] ?? 'claude-sonnet-5-5';
const runner = agentSdkRunner({ credential: () => ({ mode: 'login' }) });
const NOW = '2026-11-13T10:00:00.000Z';

type Case = {
  name: string;
  /** Project → its sessions → the lines of each session's chunks. */
  source: { title: string; summary: string; sessions: Record<string, string[]> };
  target: { title: string; summary: string; sessions: Record<string, string[]> };
  move?: string[];
  must: RegExp[];
  mustNot: RegExp[];
  /** Text that only one chunk holds; the draft must cite that chunk. */
  citeChunkWith?: string;
  needUnknowns?: boolean;
};

const filler = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `[2026-11-10T0${i % 9}:00Z] assistant: 继续排查${topic}，第 ${i + 1} 轮：读了日志，改了两处实现，跑了单元测试。`).join('\n');

const CASES: Case[] = [
  {
    name: '尾部决定推翻早先目标',
    source: { title: '杂项修复', summary: '零碎修复', sessions: { 'codex:s1': [
      '[2026-11-10T01:00Z] user: 帮我做一个采集对账工具，目标是自动把缺的会话重新采一遍补齐。',
      filler('对账工具', 30),
      '[2026-11-10T09:00Z] user: 重新采集会唤醒已关闭的 agent，不能做。最终决定：对账工具只读，只列出每个来源的缺口，不自动补采。完成标准是：能按来源列出已发现数、有正文数和缺口清单，并且运行时不向 daemon 写任何东西。',
      '[2026-11-10T09:05Z] assistant: 明白，已改为只读对账，删除了自动补采的代码。',
    ] } },
    target: { title: '采集', summary: '采集相关', sessions: { 'codex:t1': ['[2026-11-09T01:00Z] user: 我需要知道每台机器的会话到底有没有收全。', '[2026-11-09T01:10Z] assistant: 现在只有心跳，无法判断正文是否收全。'] } },
    must: [/只读/, /缺口/],
    mustNot: [/自动补采[^。]*(实现|支持|完成)/],
    citeChunkWith: '最终决定',
  },
  {
    name: '部分合并不混入未选 session',
    source: { title: '周三的工作', summary: '登录页重做和采集修复', sessions: {
      'codex:s1': ['[2026-11-10T01:00Z] user: Paseo 采集器发中文长消息时请求超过 512KiB 被拒，修一下。', '[2026-11-10T02:00Z] assistant: 根因是按字符数算字节预算，已改为 UTF-8 字节数，回归测试通过。'],
      'codex:s2': ['[2026-11-10T03:00Z] user: 把管理员登录页重做成左右分栏，加上忘记密码入口。', '[2026-11-10T04:00Z] assistant: 登录页已改为左右分栏。'],
    } },
    target: { title: '采集可靠性', summary: '', sessions: { 'codex:t1': ['[2026-11-09T01:00Z] user: 关掉 herdr 窗口后最后一段输出没被收上来，要保证不漏。', '[2026-11-09T02:00Z] assistant: 已对关闭的 pane 补读尾部，测试通过。'] } },
    move: ['codex:s1'],
    must: [/采集/],
    mustNot: [/登录/, /分栏/, /忘记密码/],
  },
  {
    name: '同一目标跨 session，旧标题是会话式的',
    source: { title: '讨论一下合并怎么做', summary: '聊了合并', sessions: { 'codex:s1': ['[2026-11-10T01:00Z] user: 项目合并现在一点就生效，我想先看到合并后的项目长什么样再确认。', '[2026-11-10T02:00Z] assistant: 做了合并预览：生成草稿但不写入，确认后才应用。'] } },
    target: { title: '修 stage-control 的 bug', summary: '修 bug', sessions: { 'codex:t1': ['[2026-11-09T01:00Z] user: 合并时我只想移动其中几个 session，其余留在原项目。', '[2026-11-09T02:00Z] assistant: 增加了 session 粒度选择，未选的留在来源项目。'] } },
    must: [/合并/, /预览|确认/],
    mustNot: [/^讨论/, /^修 stage-control/, /^聊/],
  },
  {
    name: '证据没说的不编造',
    source: { title: '通知', summary: '', sessions: { 'codex:s1': ['[2026-11-10T01:00Z] user: agent 等我操作时给手机推一条通知，用 ntfy。', '[2026-11-10T02:00Z] assistant: 写了推送脚本，本地用假服务端测试通过。还没有在真实手机上试过。'] } },
    target: { title: '提醒', summary: '', sessions: { 'codex:t1': ['[2026-11-09T01:00Z] user: 我经常错过 agent 的提问，希望有提醒。'] } },
    must: [/通知|推送/],
    mustNot: [/已(经)?(上线|部署|在真实手机上验证)/, /真机(验证|测试)通过/],
    needUnknowns: true,
  },
];

let failed = 0;
for (const c of CASES) {
  const db = openDb(':memory:');
  const deps = defaultDeps();
  let offset = 0;
  const chunkOf = new Map<string, number>();
  const make = (p: Case['source']) => {
    const r = execute(db, deps, { op: 'create_project', args: { title: p.title, ...(p.summary ? { summary: p.summary } : {}) }, actor: 'ai:curator', reason: 'case', evidence: ['chunk:1'] }) as { id: string };
    for (const [key, texts] of Object.entries(p.sessions)) {
      db.prepare("INSERT INTO sessions (key, agent_kind, machine, cwd, title, live_status, lifecycle, ignored, first_seen, last_seen) VALUES (?, 'codex', 'case', '/w', 't', 'idle', 'ended', 0, ?, ?)").run(key, NOW, NOW);
      for (const text of texts) {
        offset += 1;
        const info = db.prepare("INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill) VALUES (?, 'transcript', ?, ?, ?, ?, ?, 1)").run(key, offset, offset, new Date(Date.parse(NOW) + offset * 1000).toISOString(), NOW, text);
        chunkOf.set(text, Number(info.lastInsertRowid));
      }
      execute(db, deps, { op: 'link_session', args: { session: key, project: r.id }, actor: 'user' });
    }
    return r.id;
  };
  const source = make(c.source);
  const target = make(c.target);
  const out = await draftMerge(db, deps, runner, model, resolveMergeScope(db, source, target, c.move));
  const problems: string[] = [];
  if (!out.ok) problems.push(`没有生成草稿：${out.kind} ${out.message}`);
  else {
    const d = out.draft;
    const all = [d.title, d.summary, d.why, d.done_criteria].join('\n');
    for (const re of c.must) if (!re.test(all)) problems.push(`缺少 ${re}`);
    for (const re of c.mustNot) if (re.test(all) || re.test(d.title)) problems.push(`不应出现 ${re}`);
    if (c.citeChunkWith) {
      const id = [...chunkOf].find(([text]) => text.includes(c.citeChunkWith!))![1];
      if (!d.evidence.some((e) => e.chunk_ids.includes(id))) problems.push(`没有引用含「${c.citeChunkWith}」的证据 chunk ${id}`);
    }
    if (c.needUnknowns && d.unknowns.length === 0) problems.push('应列出未知事项');
    console.log(`\n## ${c.name}\n标题：${d.title}\n简介：${d.summary}\n为什么：${d.why}\n完成标准：\n${d.done_criteria}\n未知：${d.unknowns.join('；') || '（无）'}\n证据：${JSON.stringify(d.evidence)}\n读取：${out.coverage.mode}，${out.coverage.model_calls} 次调用`);
  }
  if (problems.length > 0) failed += 1;
  console.log(problems.length === 0 ? `=> 通过：${c.name}` : `=> 未通过：${c.name}：${problems.join('；')}`);
  db.close();
}
console.log(`\n${CASES.length - failed}/${CASES.length} 个案例通过（模型 ${model}）`);
process.exit(failed === 0 ? 0 : 1);
