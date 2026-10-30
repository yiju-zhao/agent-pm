import { copyText } from '../copy.ts';
import { STATUS_LABEL, statusClass } from '../format.ts';
import { useToast } from './toast.tsx';

/** What the tag shows of a session; both a `SessionView` and the `SessionTag` of the project read model fit. */
export type SessionTagInfo = {
  short_id: string;
  machine: string;
  agent_kind: string;
  effective_status: string;
  title: string;
};

/**
 * `<machine> · <agent> · ●<status> · <short id>`. Clicking copies the short id (to paste into herdr), and says whether it
 * worked; when the browser will not copy, the id is in the message so it can be selected by hand.
 */
export function SessionTag({ session }: { session: SessionTagInfo }) {
  const toast = useToast();
  const { short_id: shortId } = session;

  const copy = async () => {
    const ok = await copyText(shortId);
    toast(ok ? `已复制 ${shortId}` : `复制失败，短 ID：${shortId}`);
  };

  return (
    <button type="button" className="sess" title={session.title} onClick={copy}>
      {`${session.machine} · ${session.agent_kind} · `}
      <span className={statusClass(session.effective_status)}>●</span>
      {`${STATUS_LABEL[session.effective_status] ?? session.effective_status} · ${shortId}`}
    </button>
  );
}
