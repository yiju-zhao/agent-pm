import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { ContextAddressError, parseAddress } from '../context/address.ts';
import { markOverviewRead, readItem, readOverview, readSession, readTurn, ISOLATED_TEXT, REFUSAL_NOTE, resolveSession } from '../context/read.ts';
import type { DomainDeps } from '../domain/types.ts';
import type { SourceConfig } from '../server/coverage.ts';
import { searchContext } from '../server/search.ts';
import { oneLine } from '../understand/render.ts';
import type { ToolDef } from '../understand/tool-def.ts';
import { defineTool } from './define-tool.ts';

const OVERVIEW_SECTION_CHARS = 330;

export type OverviewSources = { config: SourceConfig; startedAt: Date };

export function searchTool(db: DatabaseSync): ToolDef {
  const defaultLimit = 20;
  const maxLimit = 100;
  const labels = { project: '项目', milestone: '里程碑', todo: 'todo', decision: '决策', blocker: '阻塞', digest: '摘要', message: '消息' };
  return defineTool(
    {
      name: 'pm_search',
      description: '检索账本、摘要和对话。可按项目、session 或来源范围收窄结果，按最新时间列出片段。消息地址可以直接交给 pm_get_turn。',
      input: {
        query: z.string().trim().min(1),
        limit: z.number().optional(),
        scope: z.enum(['all', 'ledger', 'digests', 'messages']).optional(),
        project_id: z.string().optional(),
        session: z.string().optional(),
      },
    },
    (args) => {
      const sessionKey = args.session ? resolveSession(db, args.session.replace(/^s:/, '')).key : undefined;
      const hits = searchContext(db, args.query, {
        limit: Math.min(maxLimit, Math.max(1, Math.floor(args.limit ?? defaultLimit))),
        scope: args.scope ?? 'all',
        projectId: args.project_id,
        sessionKey,
      });
      const title = db.prepare('SELECT title FROM projects WHERE id=?');
      return {
        text:
          hits
            .map(
              (h) =>
                `- ${labels[h.kind]} · ${h.project_id ? oneLine(String(title.get(h.project_id)?.title ?? '')) + '（' + h.project_id + '） · ' : ''}${oneLine(h.snippet)} · ${h.ref}`,
            )
            .join('\n') || '没有匹配的内容',
      };
    },
  );
}

export function sessionTools(db: DatabaseSync, deps: DomainDeps, background: boolean, inspected?: Set<string>): ToolDef[] {
  return [
    defineTool(
      {
        name: background ? 'get_session' : 'pm_get_session',
        description: '按 session 地址或短 ID 查看回合大纲，每行末尾是回合地址。可用 before 向前翻页，再将回合地址交给 pm_get_turn。',
        input: {
          session: z.string().min(1),
          before: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
      },
      (args) => {
        const addr = parseAddress(args.session.startsWith('s:') ? args.session : 's:' + args.session);
        if (addr.kind !== 'session') throw new ContextAddressError('需要 session 地址');
        const s = readSession(db, deps.now(), addr.session, args, background);
        const lines = [`${s.title} · ${s.machine} · ${s.status} · ${s.projects.join('、') || '未归属'} · ${s.address}`];
        if (s.card)
          lines.push(
            `目标：${s.card.goal} · 状态：${s.card.state} · 等待：${s.card.waiting_on ?? '—'} · 下一步：${s.card.next ?? '—'} · 备注：${s.card.note ?? '—'} · 截至回合 ${s.card_as_of_turn ?? '—'}，落后 ${s.card_lag ?? '—'} · ${s.address}`,
          );
        if (s.no_turn_index)
          lines.push(
            '没有回合索引',
            ...s.digests.map((d) => `${d.ts_end ?? ''} · ${oneLine(d.json ?? '').slice(0, 200)} · digest:${d.id}`),
          );
        for (const t of s.turns)
          lines.push(
            `- ${t.ts_start ?? '?'}–${t.ts_end ?? '?'} · ${oneLine(t.user)} → ${oneLine(t.assistant) || '—'} · 工具 ${t.tool_calls}/失败 ${t.tool_failures}${t.in_progress ? ' · 进行中' : ''}${t.refused ? ' · ' + (background ? ISOLATED_TEXT : REFUSAL_NOTE) : ''} · ${t.address}`,
          );
        if (s.earlier_digests) lines.push(`还有 ${s.earlier_digests} 份更早摘要，传 before=${s.digests.at(-1)!.id} · ${s.address}`);
        if (s.earlier) lines.push(`更早还有 ${s.earlier} 回合，传 before=${s.turns[0].n} · ${s.address}`);
        return { text: lines.join('\n') };
      },
    ),
    defineTool(
      {
        name: background ? 'get_turn' : 'pm_get_turn',
        description: '按回合地址读取消息全文和每次工具调用的概要。每行末尾的条目地址可以直接交给 pm_read_raw 分页读取原文。',
        input: { turn: z.string() },
      },
      (args) => {
        const a = parseAddress(args.turn);
        if (a.kind !== 'turn') throw new ContextAddressError('需要回合地址');
        const turn = readTurn(db, a.session, a.turn, background);
        if (turn.items.some((i) => !i.refused)) inspected?.add(turn.address);
        return {
          text: turn.items
            .map(
              (i) =>
                `- ${i.kind} · ${i.tool ? `${i.tool.name} ${oneLine(i.tool.input)} · ${i.tool.status} · exit=${i.tool.exit_code ?? '—'}` : i.text}${!background && i.refused ? ' · ' + REFUSAL_NOTE : ''} · ${i.address}`,
            )
            .join('\n'),
        };
      },
    ),
  ];
}

export function contextTools(db: DatabaseSync, deps: DomainDeps, reader: string, sources?: OverviewSources): ToolDef[] {
  return [
    defineTool(
      {
        name: 'pm_overview',
        description: '查看盲区、待处理、正在运行的会话与自本把 key 上次读取以来的变化。用行末 session 地址继续调用 pm_get_session。',
        input: {},
      },
      () => {
        const now = deps.now();
        const overview = readOverview(db, now, reader, sources);
        const parts = [
          [
            '盲区',
            [
              `待摘要会话 ${overview.undigested}，拒摘窗口 ${overview.refusals}`,
              ...overview.sources.map((s) => `${s.id} · ${s.state} · ${s.last_sync ?? '未同步'}`),
            ],
            '查看来源覆盖页',
          ],
          ['待处理', overview.pending.map((p) => `${p.since ?? ''} · ${oneLine(p.text).slice(0, 90)} · ${p.ref}`), '查看 Inbox'],
          [
            '正在运行',
            overview.running.map(
              (s) =>
                `${s.machine} · ${s.projects.join('、') || '未归属'} · 回合 ${s.turn ?? '—'} · 已过 ${Math.floor((s.age_ms ?? 0) / 1000)} 秒 · ${oneLine(s.user)} · ${s.address}`,
            ),
            '调用 pm_list_sessions',
          ],
          [
            '自上次以来',
            overview.changes.map(
              (c) =>
                `阶段 ${c.stages}，新决策 ${c.decisions}，完成 todo ${c.completed_todos}，新阻塞 ${c.new_blockers}，解除 ${c.cleared_blockers} · ${c.project_id}`,
            ),
            '调用 pm_timeline',
          ],
        ] as const;
        const text = parts
          .map(([title, lines, more]) => {
            let section = title;
            let shown = 0;
            for (const line of lines) {
              if (section.length + line.length > OVERVIEW_SECTION_CHARS) break;
              section += '\n- ' + line;
              shown++;
            }
            if (shown < lines.length) section += `\n省略 ${lines.length - shown} 条，${more}`;
            return lines.length ? section : section + '\n无';
          })
          .join('\n\n');
        markOverviewRead(db, reader, now, overview.last_event_id);
        return { text };
      },
    ),
    ...sessionTools(db, deps, false),
    defineTool(
      {
        name: 'pm_read_raw',
        description: '按条目地址和 offset 读取原文，每页最多 4000 字符。内容已截断时标注保留长度，原文不在库里时提供上游指针。',
        input: { item: z.string(), offset: z.number().int().nonnegative().optional() },
      },
      (args) => {
        const a = parseAddress(args.item);
        if (a.kind !== 'item') throw new ContextAddressError('需要条目地址');
        const raw = readItem(db, a.session, a.turn, a.item, { offset: args.offset ?? 0 });
        const truncations: string[] = [];
        if (raw.truncated && 'input' in raw.truncated) {
          for (const [section, cut] of [['输入', raw.truncated.input], ['输出', raw.truncated.output]] as const) {
            if (cut) truncations.push(`${section}采集截断：原长 ${cut.original_chars}，保留 ${cut.kept_chars}`);
          }
        } else if (raw.truncated) {
          truncations.push(`采集截断：原长 ${raw.truncated.original_chars}，保留 ${raw.truncated.kept_chars}`);
        }
        return {
          text: [
            raw.text,
            raw.refused ? REFUSAL_NOTE : null,
            raw.missing ? JSON.stringify(raw.pointer) : null,
            ...truncations,
            `共 ${raw.total} 字符${raw.next_offset !== null ? `，还有 ${raw.total - raw.next_offset}，传 offset=${raw.next_offset}` : ''} · ${raw.address}`,
          ]
            .filter(Boolean)
            .join('\n'),
        };
      },
    ),
  ];
}
