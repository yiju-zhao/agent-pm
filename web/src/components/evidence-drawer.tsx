import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EvidenceChunk, EvidenceView } from '../../../src/domain/evidence.ts';
import { AUTH_EVENT, errorText } from '../api.ts';
import { shortTime } from '../format.ts';
import { useApi } from '../use-api.ts';
import { SessionTag } from './session-tag.tsx';
import { evidenceSourceLine, SourceBadges } from './source-badges.tsx';

// ---- references --------------------------------------------------------------------------------------------------

type RefInfo = { label: string; /** The reference to ask the server for; `null` when there is nothing to open. */ openRef: string | null };

/**
 * What a piece of evidence is called on the page, and whether it can be opened. A `#…` suffix (a line in a chunk) is
 * not part of the reference. Only digests and chunks have a text behind them (`GET /evidence/:ref`); events and
 * questions are labels.
 */
function readRef(raw: string): RefInfo {
  const base = raw.split('#', 1)[0];
  const m = /^(digest|chunk|event|question):(.+)$/.exec(base);
  if (m === null) return { label: raw, openRef: null };
  const [, kind, id] = m;
  const isNumber = /^[1-9][0-9]*$/.test(id);
  switch (kind) {
    case 'digest':
      return isNumber ? { label: `摘要 #${id}`, openRef: base } : { label: raw, openRef: null };
    case 'chunk':
      return isNumber ? { label: `片段 #${id}`, openRef: base } : { label: raw, openRef: null };
    case 'event':
      return { label: `事件 #${id}`, openRef: null };
    default:
      return { label: `问题 ${id}`, openRef: null };
  }
}

/** A small tag for one piece of evidence. Digests and chunks open the drawer with the source text. */
export function EvidenceLink({ evidence }: { evidence: string }) {
  const { label, openRef } = readRef(evidence);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  if (openRef === null) return <span className="tag">{label}</span>;
  return (
    <>
      <button type="button" ref={trigger} className="tag tag-btn" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? <EvidenceDrawer evidenceRef={openRef} onClose={close} /> : null}
    </>
  );
}

// ---- the drawer --------------------------------------------------------------------------------------------------

const NO_TOPICS: never[] = [];

const CHUNK_KIND: Record<string, string> = { transcript: '对话', screen: '屏幕', report: '汇报' };

/** The digest is the model's JSON, cast without checking: any field may be missing or of the wrong type. */
function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The text of a list entry: the string itself, or the `key` field of an object. */
function textOf(entry: unknown, key: string): string | null {
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null) {
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function texts(value: unknown, key = 'text'): string[] {
  return entries(value)
    .map((entry) => textOf(entry, key))
    .filter((text): text is string => text !== null && text !== '');
}

type TopicLine = { label: string; summary: string };

function topics(value: unknown): TopicLine[] {
  return entries(value)
    .map((entry) => ({ label: textOf(entry, 'label') ?? '', summary: typeof entry === 'string' ? '' : (textOf(entry, 'summary') ?? '') }))
    .filter((topic) => topic.label !== '' || topic.summary !== '');
}

function DigestLists({ digest }: { digest: unknown }) {
  const d = typeof digest === 'object' && digest !== null ? (digest as Record<string, unknown>) : {};
  const sections: Array<{ title: string; items: Array<string | TopicLine> }> = [
    { title: '主题', items: topics(d.topics) },
    { title: '决策', items: texts(d.decisions) },
    { title: '进展', items: texts(d.progress) },
    { title: '阻塞', items: texts(d.blockers) },
  ];
  return (
    <>
      {sections
        .filter((s) => s.items.length > 0)
        .map((s) => (
          <section key={s.title} className="drawer-section">
            <div className="h">{s.title}</div>
            <ul>
              {s.items.map((item, i) => (
                <li key={i}>
                  {typeof item === 'string' ? (
                    item
                  ) : (
                    <>
                      {item.label !== '' ? <strong>{item.label}</strong> : null}
                      {item.label !== '' && item.summary !== '' ? '：' : null}
                      {item.summary}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}

function timeRange(start: string | null, end: string | null): string | null {
  if (start !== null && end !== null) return `${shortTime(start)} – ${shortTime(end)}`;
  const one = start ?? end;
  return one === null ? null : shortTime(one);
}

function Chunk({ chunk }: { chunk: EvidenceChunk }) {
  const when = timeRange(chunk.ts_start, chunk.ts_end);
  const head = [`片段 #${chunk.id}`, CHUNK_KIND[chunk.kind] ?? chunk.kind, when, evidenceSourceLine(chunk.source ?? null)]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <section className="chunk">
      <div className="dim">{head}</div>
      <pre>{chunk.truncated ? `${chunk.text}…（已截断）` : chunk.text}</pre>
    </section>
  );
}

function Body({ view }: { view: EvidenceView }) {
  const when = timeRange(view.ts_start, view.ts_end);
  return (
    <>
      <div className="drawer-meta">
        {view.session !== null ? <SessionTag session={view.session} /> : <span className="dim">{`session ${view.session_key}（已清除）`}</span>}
        {view.session !== null ? <SourceBadges sources={view.session.sources ?? []} /> : null}
        {when !== null ? <span className="dim">{when}</span> : null}
      </div>
      {view.digest !== null ? <DigestLists digest={view.digest} /> : null}
      <section className="drawer-section">
        <div className="h">对话原文</div>
        {view.chunks.length === 0 ? <div className="dim">没有对话原文</div> : view.chunks.map((chunk) => <Chunk key={chunk.id} chunk={chunk} />)}
      </section>
    </>
  );
}

/**
 * The source of a decision: who said it (session, time) and the conversation text, from `GET /evidence/:ref`. That
 * text is raw conversation, so the request carries the token; without one the drawer says so and offers the token dialog.
 * `Esc`, 关闭 or a click beside the drawer closes it.
 */
export function EvidenceDrawer({ evidenceRef, onClose }: { evidenceRef: string; onClose: () => void }) {
  const { data, error, loading, reload } = useApi<EvidenceView>(`/evidence/${encodeURIComponent(evidenceRef)}`, NO_TOPICS, { auth: true });
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The token dialog (opened from here, or on top of us) takes Esc for itself.
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  let content;
  if (data !== undefined) {
    content = <Body view={data} />;
  } else if (error !== null) {
    content = (
      <div className="drawer-error" role="alert">
        <p>{error.status === 404 ? '找不到这条证据（可能已被清除）' : errorText(error)}</p>
        <div className="drawer-actions">
          {error.status === 401 ? (
            <button type="button" onClick={() => window.dispatchEvent(new Event(AUTH_EVENT))}>
              设置 token
            </button>
          ) : null}
          <button type="button" disabled={loading} onClick={reload}>
            重试
          </button>
        </div>
      </div>
    );
  } else {
    content = <div className="dim">加载中…</div>;
  }

  // Rendered into <body>, so no ancestor's overflow or stacking can clip or hide it.
  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-labelledby={titleId}>
        <header className="drawer-head">
          <h2 id={titleId}>{`证据 · ${readRef(evidenceRef).label}`}</h2>
          <button type="button" autoFocus onClick={onClose}>
            关闭
          </button>
        </header>
        {content}
      </aside>
    </div>,
    document.body,
  );
}
