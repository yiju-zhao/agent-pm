import { useEffect, useState } from 'react';
import type { EventView } from '../../../src/domain/read.ts';
import { apiSend } from '../api.ts';
import { actorLabel, opLabel, shortTime } from '../format.ts';
import { useWrite } from '../use-write.ts';
import { Section } from './blocks.tsx';
import { ConfirmButton } from './confirm-button.tsx';
import { EvidenceLink } from './evidence-drawer.tsx';

/** How many events show at first, and how many more each 显示更多 adds. */
const PAGE = 30;

/**
 * How many events the server sends at most (`EVENTS_IN_DETAIL` in src/domain/read.ts, which this file cannot import:
 * that module pulls in node modules). tests/web/event-log.test.tsx fails when the two differ.
 */
export const EVENTS_SHOWN = 200;

/** The JSON of a stored value, 2 spaces indented. An event with nothing there reads `null`. */
function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

type RowProps = {
  event: EventView;
  /** Whether the event a revert link points to is in the list at all. */
  has(id: number): boolean;
  jump(id: number): void;
  reload(): void;
};

/** `已被 #N 撤销` / `撤销了 #N`: a button that scrolls to #N (a hash link would be taken by the page router). */
function JumpLink({ text, target, has, jump }: { text: string; target: number } & Pick<RowProps, 'has' | 'jump'>) {
  const present = has(target);
  return (
    <button
      type="button"
      className="link-btn"
      disabled={!present}
      title={present ? undefined : '这条不在显示的事件里'}
      onClick={() => jump(target)}
    >
      {text}
    </button>
  );
}

function EventRow({ event, has, jump, reload }: RowProps) {
  const { fire } = useWrite(reload);
  const [open, setOpen] = useState(false);
  const { id, reverted_by: revertedBy, reverts } = event;
  return (
    <li id={`event-${id}`} className={revertedBy === null ? 'event-row' : 'event-row reverted'}>
      <span className="event-id">{`#${id}`}</span>
      <span className="dim">{shortTime(event.occurred_at)}</span>
      <span>{actorLabel(event.actor)}</span>
      <span className="event-op">{opLabel(event.op)}</span>
      {event.entity !== null ? <span className="dim">{event.entity}</span> : null}
      {event.is_veto ? <span className="tag veto">否决</span> : null}
      {event.reason !== null && event.reason !== '' ? <span className="event-reason">{event.reason}</span> : null}
      {event.evidence.map((evidence, i) => (
        <EvidenceLink key={`${i}:${evidence}`} evidence={evidence} />
      ))}
      {reverts !== null ? <JumpLink text={`撤销了 #${reverts}`} target={reverts} has={has} jump={jump} /> : null}
      {revertedBy !== null ? (
        <JumpLink text={`已被 #${revertedBy} 撤销`} target={revertedBy} has={has} jump={jump} />
      ) : (
        <ConfirmButton label="撤销" confirmLabel="确定撤销？" onConfirm={() => fire(() => apiSend('POST', `/events/${id}/revert`))} />
      )}
      <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        详情
      </button>
      {open ? (
        <div className="event-detail">
          <pre>{jsonText(event.before)}</pre>
          <span aria-hidden="true">→</span>
          <pre>{jsonText(event.after)}</pre>
        </div>
      ) : null}
    </li>
  );
}

/**
 * What happened to the project, newest first (spec 9.2): who did what, why, on what evidence. Every event nothing has
 * reverted has 撤销; whether it can be reverted is the server's to say, and its answer is shown as it comes. A revert
 * and the event it reverted point at each other, and the pointer scrolls there.
 */
export function EventLog({ events, reload }: { events: EventView[]; reload(): void }) {
  const [count, setCount] = useState(PAGE);
  const [jumpTo, setJumpTo] = useState<number | null>(null);

  // Runs after the rows it asks for have been drawn.
  useEffect(() => {
    if (jumpTo === null) return;
    document.getElementById(`event-${jumpTo}`)?.scrollIntoView({ block: 'center' });
    setJumpTo(null);
  }, [jumpTo]);

  const has = (id: number) => events.some((e) => e.id === id);
  const jump = (id: number) => {
    const index = events.findIndex((e) => e.id === id);
    if (index < 0) return;
    setCount((c) => Math.max(c, index + 1));
    setJumpTo(id);
  };

  return (
    <Section title="事件日志">
      <p className="dim">{`只显示最近 ${EVENTS_SHOWN} 条`}</p>
      {events.length === 0 ? (
        <p className="dim">还没有事件</p>
      ) : (
        <ul className="events">
          {events.slice(0, count).map((event) => (
            <EventRow key={event.id} event={event} has={has} jump={jump} reload={reload} />
          ))}
        </ul>
      )}
      {events.length > count ? (
        <button type="button" onClick={() => setCount((c) => c + PAGE)}>
          显示更多
        </button>
      ) : null}
    </Section>
  );
}
