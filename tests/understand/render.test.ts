import { afterEach, beforeEach, expect, test } from 'vitest';
import { getProject, listProjects } from '../../src/domain/read.ts';
import type { ProjectCard, ProjectDetail } from '../../src/domain/read.ts';
import { renderBrief, renderProjectIndex, renderProjectMarkdown } from '../../src/understand/render.ts';
import { NOW, setup } from '../domain/helpers.ts';
import type { Setup } from '../domain/helpers.ts';

let t: Setup;

beforeEach(() => {
  t = setup();
});

afterEach(() => {
  t.db.close();
});

function detail(id: string): ProjectDetail {
  const found = getProject(t.db, new Date(NOW), id);
  if (!found) throw new Error(`no project ${id}`);
  return found;
}

function cards(): ProjectCard[] {
  return listProjects(t.db, new Date(NOW), {});
}

/** The machine `laptop` reported a heartbeat at NOW, so the session shows as live. */
function addSession(key: string): void {
  t.db
    .prepare(`INSERT OR IGNORE INTO machines (label, last_heartbeat, collector_version) VALUES ('laptop', ?, 'test')`)
    .run(NOW);
  t.db
    .prepare(
      `INSERT INTO sessions (key, agent_kind, machine, terminal_id, title, lifecycle, live_status, ignored, first_seen, last_seen)
       VALUES (?, ?, 'laptop', 'term_1', ?, 'live', 'working', 0, ?, ?)`,
    )
    .run(key, key.slice(0, key.indexOf(':')), `title of ${key}`, NOW, NOW);
}

/** A build-stage project with a milestone, an open and a done todo, an open and a cleared blocker, and a live session. */
function fullProject(): string {
  const p = t.user('create_project', {
    title: '做 herdr-pm',
    stage: 'explore',
    priority: 'P1',
    summary: '把分散在各终端的 agent 工作收拢成一张看板',
    why: '同时开着十几个 session，记不住谁在做什么',
    done_criteria: '首页能一眼看出每个项目走到哪一步',
  }).id;
  t.user('upsert_milestone', { project: p, title: '理解层上线', status: 'doing' });
  t.user('upsert_todo', { project: p, title: '写摘要员', priority: 'P0' });
  const done = t.user('upsert_todo', { project: p, title: '已完成的 todo 标题' }).id;
  t.user('upsert_todo', { project: p, id: done, status: 'done' });
  t.user('set_blocker', { project: p, text: '等订阅额度恢复', kind: 'external' });
  const cleared = t.user('set_blocker', { project: p, text: '已解决的阻塞' }).id;
  t.user('clear_blocker', { project: p, id: cleared });
  addSession('claude:live1111aaaabbbb');
  expect(t.user('link_session', { session: 'claude:live1111aaaabbbb', project: p }).status).toBe('applied');
  return p;
}

// ---- renderBrief -------------------------------------------------------------------------------------------------

test('brief shows stage in Chinese, open todos, open blockers and active sessions, and omits empty sections', () => {
  const p = fullProject();
  const b = renderBrief(detail(p));

  expect(b).toContain('# 做 herdr-pm');
  expect(b).toContain(`ID：${p}`);
  expect(b).toContain('阶段：探索');
  expect(b).toContain('优先级：P1');
  expect(b).toContain('一句话：把分散在各终端的 agent 工作收拢成一张看板');
  expect(b).toContain('为什么：同时开着十几个 session，记不住谁在做什么');
  expect(b).toContain('完成标准：首页能一眼看出每个项目走到哪一步');
  expect(b).toContain('当前里程碑：m_1 · 理解层上线（进行中）');
  expect(b).toContain('- t_1 · 写摘要员 · 待做 · P0');
  expect(b).toContain('- b_1 · 等订阅额度恢复 · 外部依赖');
  expect(b).toContain('- live1111 · laptop · claude');

  expect(b).not.toContain('已完成的 todo 标题');
  expect(b).not.toContain('已解决的阻塞');
  expect(b).not.toMatch(/决策/); // no decisions: the section is left out
});

test('brief of a bare project is only its title, id and stage', () => {
  const p = t.user('create_project', { title: '空项目' }).id;
  expect(renderBrief(detail(p))).toBe(`# 空项目\nID：${p}\n阶段：idea`);
});

test('brief lists at most 10 open todos and the 5 most recent decisions, and says how many todos it left out', () => {
  const p = t.user('create_project', { title: 'busy', stage: 'build' }).id;
  for (let i = 1; i <= 12; i++) t.user('upsert_todo', { project: p, title: `todo number ${i}` });
  for (let i = 1; i <= 7; i++) {
    t.user('record_decision', { project: p, text: `decision number ${i}`, decided_at: `2026-10-${String(10 + i)}T08:00:00.000Z` });
  }
  const b = renderBrief(detail(p));

  expect(b.match(/todo number/g)).toHaveLength(10);
  expect(b).toContain('另有 2 条');
  expect(b.match(/decision number/g)).toHaveLength(5);
  expect(b).toContain('2026-10-17 · decision number 7');
  expect(b).toContain('decision number 3');
  expect(b).not.toContain('decision number 2');
});

test('brief puts a doing todo before a todo and keeps multi-line titles on one line', () => {
  const p = t.user('create_project', { title: 'p' }).id;
  t.user('upsert_todo', { project: p, title: '第一行\n第二行' });
  t.user('upsert_todo', { project: p, title: '正在做', status: 'doing' });
  const b = renderBrief(detail(p));

  expect(b.indexOf('正在做')).toBeLessThan(b.indexOf('第一行'));
  expect(b).toContain('第一行 第二行');
});

test('brief of a merged project says where it went', () => {
  const target = t.user('create_project', { title: 'target' }).id;
  const p = t.user('create_project', { title: 'old' }).id;
  expect(t.user('transition_stage', { project: p, stage: 'merged', merge_into: target }).status).toBe('applied');
  expect(renderBrief(detail(p))).toContain(`阶段：合并 · 已合并到：${target}`);
});

// ---- renderProjectMarkdown ---------------------------------------------------------------------------------------

test('project markdown includes decisions with evidence and recent events', () => {
  const p = fullProject();
  t.ai('record_decision', { project: p, text: '摘要用 Haiku，整理用 Sonnet' }, { reason: '用户在对话里定了', evidence: ['chunk:12', 'digest:3'] });
  const md = renderProjectMarkdown(detail(p));

  expect(md).toMatch(/## 决策\n- d_1 · 2026-10-29 · 摘要用 Haiku，整理用 Sonnet\n {2}证据：chunk:12, digest:3/);
  expect(md).toContain('## 最近事件');
  expect(md).toMatch(/- #\d+ · 2026-10-29 12:00 · ai:curator · record_decision · decisions:d_1 · 用户在对话里定了/);
  expect(md).toMatch(/- #\d+ · 2026-10-29 12:00 · user · create_project · projects:p_1/);
});

test('project markdown carries everything the brief does, plus all milestones, todos (done too) and contributions', () => {
  const p = fullProject();
  t.user('upsert_milestone', { project: p, title: '接入 MCP' });
  const md = renderProjectMarkdown(detail(p));
  const brief = renderBrief(detail(p));

  // Everything the brief says about the project itself is in the full view.
  for (const line of ['# 做 herdr-pm', '阶段：探索', '优先级：P1', '当前里程碑：m_1 · 理解层上线（进行中）']) {
    expect(brief).toContain(line);
    expect(md).toContain(line);
  }
  expect(md).toContain('- b_1 · 等订阅额度恢复 · 外部依赖');
  expect(md).toContain('- live1111 · laptop · claude');

  expect(md).toContain('## 里程碑\n- m_1 · 理解层上线 · 进行中\n- m_2 · 接入 MCP · 待做');
  expect(md).toContain('- t_1 · 写摘要员 · 待做 · P0');
  expect(md).toContain('- t_2 · 已完成的 todo 标题 · 已完成'); // the brief leaves done todos out
  expect(md).toMatch(/## 贡献记录\n- c_1 · live1111 · laptop · claude/);
  expect(md).not.toContain('已解决的阻塞');
  expect(md).not.toContain('## 决策'); // none recorded
});

test('project markdown lists only the 20 newest events', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  const todo = t.user('upsert_todo', { project: p, title: 'busy' }).id;
  for (let i = 1; i <= 24; i++) t.user('upsert_todo', { project: p, id: todo, title: `rev ${i}` });
  const md = renderProjectMarkdown(detail(p));
  const events = md.slice(md.indexOf('## 最近事件')).split('\n').filter((l) => l.startsWith('- #'));

  expect(events).toHaveLength(20);
  expect(events[0]).toContain('upsert_todo');
  expect(md).not.toContain('create_project'); // fell off the end
});

test('project markdown marks reverted events and what the user deleted, so the curator does not redo them', () => {
  const p = t.user('create_project', { title: 'p' }).id;
  const vetoedTodo = t.user('upsert_todo', { project: p, title: '用户删掉的 todo' }).id;
  t.user('delete_todo', { project: p, id: vetoedTodo });
  const edit = t.ai('update_project', { project: p, fields: { summary: 'AI 写的' } });
  expect(t.user('revert_event', { event_id: edit.event_id }).status).toBe('applied');
  const md = renderProjectMarkdown(detail(p));

  expect(md).toContain('## 用户删除过（不要重建）\n- todos:t_1 · 用户删掉的 todo · 2026-10-29');
  expect(md).toContain(`update_project · projects:${p} · r（已被撤销）`);
  expect(md).toContain(`revert_event · projects:${p}（撤销 #${edit.event_id}）`);
});

// ---- renderProjectIndex ------------------------------------------------------------------------------------------

test('index lists one line per project with id first', () => {
  const a = t.user('create_project', { title: '项目甲', stage: 'build', priority: 'P0', summary: '甲的摘要' }).id;
  const b = t.user('create_project', { title: '项目乙', stage: 'parked' }).id;

  expect(renderProjectIndex(cards())).toBe(`- ${a} · 项目甲 · 构建 · P0 · 甲的摘要\n- ${b} · 项目乙 · 搁置 · - · -`);
});

test('index cuts a long summary to 80 characters and keeps each project on one line', () => {
  const p = t.user('create_project', { title: '多行\n标题', summary: `${'长'.repeat(100)}\n后面还有` }).id;
  const out = renderProjectIndex(cards());

  expect(out.split('\n')).toHaveLength(1);
  expect(out).toBe(`- ${p} · 多行 标题 · idea · - · ${'长'.repeat(80)}…`);
});

test('index of no projects is empty, and an 80-character summary is not cut', () => {
  expect(renderProjectIndex([])).toBe('');
  const p = t.user('create_project', { title: 'p', summary: 'x'.repeat(80) }).id;
  expect(renderProjectIndex(cards())).toBe(`- ${p} · p · idea · - · ${'x'.repeat(80)}`);
});
