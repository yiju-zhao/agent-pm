// Builds a demo database for looking at the web UI without any collector or model:
//   node scripts/seed-demo.ts <dbPath>       (or: npm run seed:demo <dbPath>)
// It refuses to write to a path that already exists, so it can never overwrite real data.
//
// The data goes through the same functions the server uses (snapshots, chunks, operations, questions), so it is
// shaped exactly like real data: AI writes carry a reason and chunk evidence, the user's writes are locked, and one
// AI change was taken back by the user. The clock is the moment of the run, and parts of the story are set back in time.

import { existsSync, rmSync } from 'node:fs';
import { execute } from '../src/domain/execute.ts';
import type { OpName } from '../src/domain/ops.ts';
import { askUser } from '../src/domain/questions.ts';
import { defaultDeps } from '../src/domain/types.ts';
import type { Actor, DomainDeps, OpResult } from '../src/domain/types.ts';
import { openDb } from '../src/server/db.ts';
import { applySnapshot, insertChunks } from '../src/server/sessions-repo.ts';
import type { SnapshotSession } from '../src/shared/protocol.ts';

const USAGE = 'usage: node scripts/seed-demo.ts <dbPath>';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const GX10 = 'gx10-090e';
const MINI = 'mac-mini';

/** The session keys of the demo, one per row of the session page. */
const S = {
  /** Working on the P0 project. */
  runner: 'claude:0d67da1f-3b9a-4c1e-8f2a-5d7e9b1c2a40',
  /** Waiting for the user, also on the P0 project. */
  report: 'claude:7c1e4a92-55d0-4f7b-9a63-1e8c0d2b6f35',
  /** Only the screen is read; belongs to no project yet. */
  profile: 'pending:gx10-090e:term3a9f1c02',
  /** Idle, belongs to no project. */
  webui: 'claude:b52e90d4-6a17-4c38-b0e1-7f43a9c8d261',
  /** Ended 9 days ago, part of the dormant project. */
  rea: 'claude:e4a71c3b-2d85-4096-8ab7-c1f50d3e9a72',
  /** Ended 2 days ago, part of the finished project. */
  setup: 'claude:91d3f6a8-0b4e-47c2-a5d9-3e7b1c8f4e06',
};

/** What happens in one conversation, as the chunks a collector would have sent. */
const TALK: Record<string, [string, string]> = {
  [S.runner]: [
    '[user] 先把 cannbench 的评测集接进来，输出统一成 jsonl。\n[assistant] 已经接入公开 v2，三个模型的基线都跑通了；下一步统一 runner 的输出格式。',
    '[user] 评测集先用哪个？公开 v2 还是自建？\n[assistant] 公开 v2 已经有基线可以对照，先用它；自建的等第一版报告出来再说。\n[user] 好，就先用公开 v2。',
  ],
  [S.report]: [
    '[user] 帮我起一个评测报告的模板，要有质量和速度两张表。\n[assistant] 模板草稿写好了，指标口径还差一个确认：吞吐按 token/s 还是按样本/s？',
    '[assistant] 对照组在 24G 显存上跑不起来，batch size 降到 1 也会 OOM。需要你决定怎么处理。',
  ],
  [S.profile]: [
    '$ python profile_kernels.py --model dllm-7b\nkernel                time(ms)   share\nattn_fwd              41.2       38%\nmlp_fwd               33.5       31%',
    '$ python profile_kernels.py --model dllm-7b --steps 64\nstep latency p50 118ms, p95 163ms\n> ',
  ],
  [S.webui]: [
    '[user] 网页界面的 session 页先做个最小版本。\n[assistant] 已经按机器分组列出 session，下一步加关联下拉框。',
    '[user] 每次都要盯着终端才知道 agent 在等我，能不能推到手机上？\n[assistant] 可以把「等你操作」的状态推成通知，这个值得单独记成一个想法。',
  ],
  [S.rea]: [
    '[user] 帮我抓一下 Rea 客户端启动时的握手包。\n[assistant] 抓到了 3 份，握手分三步，第三步之后就是加密载荷。',
    '[user] 先只看握手阶段，加密载荷以后再说。\n[assistant] 好，我把握手流程整理成一张时序图。',
  ],
  [S.setup]: [
    '[user] 四台机器上 herdr integration 都装一下。\n[assistant] gx10-090e 和 gx10-c757 已经装好，claude 和 codex 都显示 installed。',
    '[assistant] mac-mini 和笔记本也装好了，`herdr integration status` 四台都正常。',
  ],
};

const SESSIONS: Record<string, { agent_kind: string; machine: string; cwd: string; title: string }> = {
  [S.runner]: { agent_kind: 'claude', machine: GX10, cwd: '/home/eason/projects/dllm-bench', title: '接入 cannbench 数据' },
  [S.report]: { agent_kind: 'claude', machine: GX10, cwd: '/home/eason/projects/dllm-bench', title: '评测报告模板：等你确认指标口径' },
  [S.profile]: { agent_kind: 'codex', machine: GX10, cwd: '/home/eason/scratch/kernel-profiling', title: 'profile 负载分析脚本' },
  [S.webui]: { agent_kind: 'claude', machine: MINI, cwd: '/Users/eason/Developer/repos/herdr-pm', title: '网页界面：session 页' },
  [S.rea]: { agent_kind: 'claude', machine: MINI, cwd: '/Users/eason/Documents/nasa718/rea-notes', title: 'Rea 客户端握手抓包' },
  [S.setup]: { agent_kind: 'claude', machine: GX10, cwd: '/home/eason', title: '统一安装 herdr integration' },
};

function snapshotSession(key: string, live_status: SnapshotSession['live_status']): SnapshotSession {
  const s = SESSIONS[key];
  const screen = key === S.profile;
  const native = key.startsWith('pending:') ? null : key.slice(key.indexOf(':') + 1);
  return {
    key,
    agent_kind: s.agent_kind,
    native_id: native,
    pane_id: `pane-${key.slice(-4)}`,
    terminal_id: native === null ? key.slice(key.lastIndexOf(':') + 1) : `term-${key.slice(-4)}`,
    workspace_id: 'w1',
    tab_id: 'tab1',
    cwd: s.cwd,
    title: s.title,
    live_status,
    fidelity: screen ? 'screen' : 'full',
    transcript_path: screen || native === null ? null : `${s.cwd}/.claude/${native}.jsonl`,
  };
}

function seed(dbPath: string): { projects: number; sessions: number; questions: number } {
  const db = openDb(dbPath);
  try {
    const t0 = new Date();
    let clock = t0;
    const deps: DomainDeps = { now: () => clock, newId: defaultDeps().newId };
    /** Sets the clock to `ms` before the moment of the run. */
    const ago = (ms: number) => {
      clock = new Date(t0.getTime() - ms);
    };
    const iso = (msAgo: number) => new Date(t0.getTime() - msAgo).toISOString();

    // ---- helpers ---------------------------------------------------------------------------------------------------

    const apply = (op: OpName, args: unknown, actor: Actor, why?: { reason: string; evidence: string }): Extract<OpResult, { status: 'applied' }> => {
      const result = execute(db, deps, {
        op,
        args,
        actor,
        ...(why === undefined ? {} : { reason: why.reason, evidence: [why.evidence] }),
      });
      if (result.status !== 'applied') throw new Error(`demo data: ${op} was not applied: ${JSON.stringify(result)}`);
      return result;
    };
    const user = (op: OpName, args: unknown) => apply(op, args, 'user');
    const ai = (op: OpName, args: unknown, reason: string, evidence: string) => apply(op, args, 'ai:curator', { reason, evidence });
    const created = (result: ReturnType<typeof apply>): string => {
      if (result.id === undefined) throw new Error('demo data: the operation made nothing');
      return result.id;
    };

    const snapshot = (machine: string, sessions: Array<[string, SnapshotSession['live_status']]>) =>
      applySnapshot(db, { machine, collector_version: '0.1.0', sessions: sessions.map(([k, st]) => snapshotSession(k, st)), purged: [] }, clock);

    /** Two chunks of the session's conversation, starting at the clock; returns their ids as evidence references. */
    const talk = (key: string): [string, string] => {
      const screen = key === S.profile;
      let offset = 0;
      const chunks = TALK[key].map((text, i) => {
        const start = clock.getTime() + i * 20 * MINUTE;
        const bytes = Buffer.byteLength(text);
        const chunk = {
          session_key: key,
          kind: screen ? ('screen' as const) : ('transcript' as const),
          offset_start: screen ? start : offset,
          offset_end: screen ? start : offset + bytes,
          ts_start: new Date(start).toISOString(),
          ts_end: new Date(start + 15 * MINUTE).toISOString(),
          text,
          backfill: false,
        };
        offset += bytes;
        return chunk;
      });
      insertChunks(db, { machine: SESSIONS[key].machine, chunks }, clock);
      const ids = db.prepare('SELECT id FROM chunks WHERE session_key = ? ORDER BY id').all(key) as Array<{ id: number }>;
      return [`chunk:${ids[0].id}`, `chunk:${ids[1].id}`];
    };

    // ---- 10 days ago: the project that has since gone quiet. Nothing touches it again. -------------------------------

    ago(10 * DAY);
    snapshot(MINI, [[S.rea, 'working']]);
    const [rea1, rea2] = talk(S.rea);
    const dormant = created(user('create_project', { title: 'Rea 逆向分析', priority: 'P2', stage: 'explore' }));
    ago(10 * DAY - 5 * MINUTE);
    ai('update_project', { project: dormant, fields: { summary: '逆向 macOS 上的 Rea 客户端，弄清它的会话同步协议', why: '想在自己的工具里复用它的同步能力' } }, '从抓包对话里整理出项目目标', rea1);
    const handshake = created(user('upsert_milestone', { project: dormant, title: '抓包并还原握手流程', status: 'doing' }));
    user('upsert_todo', { project: dormant, title: '整理已抓到的 3 份握手抓包', milestone_id: handshake });
    ai('record_decision', { project: dormant, text: '先只看握手阶段，加密载荷以后再说' }, '用户在对话里明确了范围', rea2);
    ai('link_session', { session: S.rea, project: dormant, milestone_id: handshake, summary: '抓包并整理握手流程', ts_start: iso(10 * DAY), ts_end: iso(10 * DAY - 40 * MINUTE) }, '这个 session 全部在做握手抓包', rea1);
    ago(9 * DAY);
    snapshot(MINI, []); // the conversation is over: the session ends

    // ---- 5 days ago: the main project starts, and one that will be parked -----------------------------------------------

    ago(5 * DAY);
    const parked = created(
      user('create_project', { title: 'loopwm 原型', priority: 'P2', stage: 'explore', summary: '把 agent 的循环状态可视化成一个小窗口' }),
    );
    const p0 = created(user('create_project', { title: 'dLLM 评测框架', priority: 'P0', stage: 'build' }));
    const m1 = created(user('upsert_milestone', { project: p0, title: '评测集接入', status: 'done' }));
    const m2 = created(user('upsert_milestone', { project: p0, title: '指标与 runner', status: 'doing' }));
    const m3 = created(user('upsert_milestone', { project: p0, title: '评测报告', status: 'todo' }));
    user('upsert_todo', { project: p0, title: '统一 runner 的输出格式', status: 'doing', milestone_id: m2 });
    user('upsert_todo', { project: p0, title: '写评测报告模板', milestone_id: m3 });
    user('upsert_todo', { project: p0, title: '接入公开 v2 评测集', status: 'done', milestone_id: m1 });

    // ---- 4 days ago: the first session on it, and the AI writes down what the project is ---------------------------------

    ago(4 * DAY);
    snapshot(GX10, [[S.runner, 'working']]);
    const [runner1, runner2] = talk(S.runner);
    ago(4 * DAY - 30 * MINUTE);
    ai(
      'update_project',
      {
        project: p0,
        fields: {
          summary: '给 Diffusion LLM 做统一评测和负载分析',
          why: '现有评测工具只覆盖自回归模型，没法比较 dLLM 在质量和速度上的取舍',
          done_criteria: '三个模型在同一套指标上跑通，并产出一份对比报告',
        },
      },
      '从对话里整理出项目的目标',
      runner1,
    );

    // ---- 3 days ago: a finished project, and the parking of the other -------------------------------------------------

    ago(3 * DAY);
    snapshot(GX10, [[S.runner, 'working'], [S.setup, 'working']]);
    const [setup1] = talk(S.setup);
    const done = created(
      user('create_project', { title: '统一四台机器的 herdr integration', priority: 'P3', stage: 'build', summary: '四台机器都装好 claude / codex integration，并确认状态上报正常' }),
    );
    ai('link_session', { session: S.setup, project: done, summary: '逐台安装并检查 integration', ts_start: iso(3 * DAY), ts_end: iso(3 * DAY - 3 * HOUR) }, '这个 session 全部在装 integration', setup1);
    ago(3 * DAY - HOUR);
    user('transition_stage', { project: parked, stage: 'parked' });

    // ---- 2 days ago ----------------------------------------------------------------------------------------------------

    ago(2 * DAY);
    snapshot(GX10, [[S.runner, 'working']]); // the setup session ended
    snapshot(MINI, [[S.webui, 'idle']]);
    const [webui1, webui2] = talk(S.webui);
    user('transition_stage', { project: done, stage: 'done' });

    // ---- yesterday: the second session, a blocker, a decision, a new idea, and a suggestion the user took back ------------

    ago(DAY);
    snapshot(GX10, [[S.runner, 'working'], [S.report, 'blocked']]);
    const [report1, report2] = talk(S.report);
    ai('set_blocker', { project: p0, text: '对照组在 24G 显存上跑不起来', kind: 'technical' }, '对话里报告了 OOM，batch size 降到 1 也不行', report2);
    ai('record_decision', { project: p0, text: '评测集先用公开 v2，自建的等第一版报告出来再说' }, '用户在对话里选定了评测集', runner2);
    ai('upsert_todo', { project: p0, title: '缩小对照组 batch size 再试', milestone_id: m2 }, '对照组 OOM，先试更小的 batch size', report2);
    ai(
      'create_project',
      { title: 'agent 等你操作时推手机通知', summary: '把「等你操作」的状态推成手机通知，不用盯着终端' },
      '用户抱怨每次都要盯着终端，值得单独记成一个想法',
      webui2,
    );
    ago(DAY - 4 * HOUR);
    const bad = ai('upsert_todo', { project: p0, title: '把评测集换成私有数据' }, '私有数据更贴近业务', runner2);
    ago(DAY - 5 * HOUR);
    user('revert_event', { event_id: bad.event_id });

    // ---- the last hour: the screen-only session shows up -----------------------------------------------------------------

    ago(HOUR);
    snapshot(GX10, [[S.runner, 'working'], [S.report, 'blocked'], [S.profile, 'idle']]);
    const [profile1] = talk(S.profile);

    // ---- now: the curator links sessions and asks its questions; the collectors have just reported -----------------------

    ago(10 * MINUTE);
    ai('link_session', { session: S.runner, project: p0, milestone_id: m2, summary: '接入评测集，统一 runner', confidence: 0.9, ts_start: iso(4 * DAY), ts_end: iso(10 * MINUTE) }, '这个 session 在做 runner', runner1);
    ai('link_session', { session: S.report, project: p0, milestone_id: m3, summary: '起草评测报告模板', confidence: 0.85, ts_start: iso(DAY), ts_end: iso(10 * MINUTE) }, '这个 session 在写报告模板', report1);

    ago(5 * MINUTE);
    const asked: OpResult[] = [
      askUser(
        db,
        deps,
        {
          kind: 'choice',
          prompt: '对照组显存不够，评测报告里怎么处理？',
          project_id: p0,
          topic: 'baseline-memory',
          evidence: [report2],
          options: [
            { label: '缩小 batch size 重跑', op: 'upsert_todo', args: { project: p0, title: '缩小 batch size 重跑对照组', milestone_id: m2 } },
            { label: '记为已知限制，报告里注明', op: 'record_decision', args: { project: p0, text: '对照组显存不够，报告里注明为已知限制' } },
            { label: '再想想', op: null },
          ],
        },
        'ai:curator',
      ),
      askUser(
        db,
        deps,
        {
          kind: 'text',
          prompt: '「Rea 逆向分析」已经很久没有动静了，下一步想做什么？',
          project_id: dormant,
          evidence: [rea2],
          option: { label: '写下下一步', op: 'upsert_todo', args: { project: dormant }, text_arg: 'title' },
        },
        'ai:curator',
      ),
      askUser(
        db,
        deps,
        {
          kind: 'choice',
          prompt: '这个 session 在分析内核耗时，它属于哪个项目？',
          session_key: S.profile,
          evidence: [profile1],
          options: [
            { label: 'dLLM 评测框架', op: 'link_session', args: { session: S.profile, project: p0, milestone_id: m2 } },
            { label: 'loopwm 原型', op: 'link_session', args: { session: S.profile, project: parked } },
            { label: '不追踪这个 session', op: 'ignore_session', args: { session: S.profile, ignored: true } },
            { label: '稍后再说', op: null },
          ],
        },
        'ai:curator',
      ),
    ];
    for (const result of asked) {
      if (result.status !== 'proposed') throw new Error(`demo data: a question was not asked: ${JSON.stringify(result)}`);
    }

    // The collectors have just reported: the sessions count as live for the next few minutes.
    clock = t0;
    snapshot(GX10, [[S.runner, 'working'], [S.report, 'blocked'], [S.profile, 'idle']]);
    snapshot(MINI, [[S.webui, 'idle']]);

    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      projects: count('SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL'),
      sessions: count('SELECT COUNT(*) AS n FROM sessions'),
      questions: count("SELECT COUNT(*) AS n FROM questions WHERE status = 'pending'"),
    };
  } finally {
    db.close();
  }
}

function main(argv: string[]): number {
  const [dbPath, ...extra] = argv;
  if (dbPath === undefined || dbPath === '' || extra.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  if (files.some((file) => existsSync(file))) {
    process.stderr.write(`seed-demo: ${dbPath} 已存在，不会覆盖；换一个路径，或先自己删掉它\n`);
    return 1;
  }
  try {
    const made = seed(dbPath);
    process.stdout.write(
      `演示库已生成：${dbPath}（${made.projects} 个项目，${made.sessions} 个 session，${made.questions} 个待回答的问题）\n` +
        `session 是静态数据，没有采集器在跟，3 分钟后会显示为离线。\n`,
    );
    return 0;
  } catch (err) {
    // A half-built database would make the next run refuse the path, so nothing of it is kept.
    for (const file of files) rmSync(file, { force: true });
    process.stderr.write(`seed-demo: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
