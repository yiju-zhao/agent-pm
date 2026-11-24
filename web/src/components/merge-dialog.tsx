import { useEffect, useState } from 'react';
import type { ProjectDetail } from '../../../src/domain/read.ts';
import type { MergePreviewView } from '../../../src/server/merge-routes.ts';
import type { SessionCoverage } from '../../../src/understand/merge-preview.ts';
import { apiGet, apiSend, errorText } from '../api.ts';
import { useWrite } from '../use-write.ts';
import { Dialog } from './dialog.tsx';

const FIELD_LABEL = { title: '标题', summary: '简介', why: '为什么', done_criteria: '完成标准' } as const;
const COVERAGE_LABEL: Record<SessionCoverage['status'], string> = {
  read: '已全部读取',
  partial: '只读取了一部分',
  ignored: '已被忽略，未读取',
  refused: '被模型提供方拒绝过，未读取',
  empty: '没有采集到内容',
};
const POLL_MS = 1500;

type Contribution = ProjectDetail['contributions'][number];
const sessionName = (c: Contribution | undefined, key: string) => (c?.session ? `${c.session.title || c.session.short_id} · ${c.session.machine} · ${c.session.short_id}` : key);

/**
 * Merging `project` into another one, in three steps: choose the target and whether the whole project or only some of
 * its sessions go; read the preview (the rewritten project, which links move, what happens to this project, what the
 * draft was and was not able to read); confirm. Nothing changes before the confirmation, and the confirmation applies
 * the preview on screen, not a new draft.
 */
export function MergeDialog({ project, targets, onClose, reload, initialTarget = '' }: {
  project: ProjectDetail;
  targets: Array<{ id: string; title: string }>;
  onClose(): void;
  reload?: () => void;
  /** A target already chosen (a suggested merge); the user can still change it. */
  initialTarget?: string;
}) {
  const { write } = useWrite(reload);
  const [target, setTarget] = useState(initialTarget);
  const [whole, setWhole] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [preview, setPreview] = useState<MergePreviewView | null>(null);
  const [overwrite, setOverwrite] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const generating = preview?.status === 'generating';
  useEffect(() => {
    if (!generating || preview === null) return;
    const id = preview.id;
    const timer = setInterval(() => {
      apiGet<MergePreviewView>(`/merge-previews/${encodeURIComponent(id)}`, { auth: true }).then(
        // An answer for a preview that was replaced meanwhile is dropped.
        (next) => setPreview((cur) => (cur?.id === id ? next : cur)),
        (err: unknown) => {
          setError(`读不到预览的进度：${errorText(err)}`);
          setPreview((cur) => (cur?.id === id ? null : cur));
        },
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [generating, preview?.id]);

  const sessions = project.contributions;
  const canPreview = target !== '' && (whole || chosen.length > 0) && !busy;
  const start = async () => {
    setBusy(true);
    setError(null);
    setOverwrite([]);
    try {
      setPreview(await apiSend<MergePreviewView>('POST', `/projects/${encodeURIComponent(project.id)}/merge-previews`, whole ? { target } : { target, sessions: chosen }));
    } catch (err) {
      // Back to the first step, where the reason is shown next to what can be changed.
      setError(errorText(err));
      setPreview(null);
    }
    setBusy(false);
  };
  const apply = async () => {
    if (preview === null) return;
    setBusy(true);
    try {
      await write(() => apiSend('POST', `/merge-previews/${encodeURIComponent(preview.id)}/apply`, { overwrite_locked: overwrite }));
      onClose();
    } catch {
      // The toast said why; show what the preview is now (most likely out of date).
      await apiGet<MergePreviewView>(`/merge-previews/${encodeURIComponent(preview.id)}`, { auth: true }).then(setPreview, () => {});
      setBusy(false);
    }
  };
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const bySession = new Map(sessions.map((c) => [c.session_key, c]));
  // A session of this project is named from the page's data; one the target already had, by what the preview says.
  const name = (key: string) => (bySession.has(key) ? sessionName(bySession.get(key), key) : (preview?.session_labels[key] ?? key));

  const allChosen = sessions.length > 0 && chosen.length === sessions.length;
  const choose = (
    <>
      <label className="merge-field">
        <span className="merge-label">合并到</span>
        <select aria-label="合并到" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">合并到哪个项目…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.title}</option>
          ))}
        </select>
      </label>
      <fieldset className="merge-scope">
        <legend className="merge-label">合并范围</legend>
        <label className={whole ? 'merge-option on' : 'merge-option'}>
          <input type="radio" name="merge-scope" checked={whole} onChange={() => setWhole(true)} />
          <span>
            <strong>整个项目</strong>
            <span className="dim">{`全部 ${sessions.length} 个 session 关联到目标项目，本项目标记为「已合并」`}</span>
          </span>
        </label>
        <label className={!whole ? 'merge-option on' : 'merge-option'}>
          <input type="radio" name="merge-scope" checked={!whole} disabled={sessions.length === 0} onChange={() => setWhole(false)} />
          <span>
            <strong>只移动选中的 session</strong>
            <span className="dim">本项目保留，未选中的 session 仍留在本项目</span>
          </span>
        </label>
        {!whole ? (
          <div className="merge-pick">
            <div className="merge-pick-head">
              <span className="dim">{`已选 ${chosen.length} / ${sessions.length}`}</span>
              <button type="button" className="tag tag-btn" onClick={() => setChosen(allChosen ? [] : sessions.map((c) => c.session_key))}>
                {allChosen ? '清空' : '全选'}
              </button>
            </div>
            <ul className="merge-sessions">
              {sessions.map((c) => (
                <li key={c.session_key}>
                  <label className={chosen.includes(c.session_key) ? 'merge-session on' : 'merge-session'}>
                    <input type="checkbox" checked={chosen.includes(c.session_key)} onChange={() => setChosen(toggle(chosen, c.session_key))} />
                    <span>
                      <span className="merge-session-name">{sessionName(c, c.session_key)}</span>
                      {c.summary ? <span className="dim">{c.summary}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </fieldset>
      <p className="merge-note">移动的只是 session 与项目的关联：会话原文、证据、历史事件以及它与其他项目的关联都不变。下一步会根据这些 session 的原始内容重写目标项目，生效前先给你预览。</p>
      {error ? <p role="alert" className="field-error">{error}</p> : null}
      <form className="modal-actions" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <button type="submit" disabled={!canPreview}>生成预览</button>
        <button type="button" onClick={onClose}>取消</button>
      </form>
    </>
  );

  const result = (p: MergePreviewView) => {
    const gaps = p.coverage?.sessions.filter((s) => s.status !== 'read' || s.truncated_chunks > 0 || s.excerpted_chunks > 0) ?? [];
    const again = <button type="button" disabled={busy} onClick={() => void start()}>重新生成</button>;
    const back = <button type="button" onClick={() => setPreview(null)}>返回修改范围</button>;
    if (p.status === 'generating') {
      return (
        <>
          <div role="status" className="merge-wait">
            <span className="merge-spinner" aria-hidden="true" />
            <span>
              <strong>正在读取所选 session 的内容并生成项目草稿…</strong>
              <span className="dim">内容多时需要几分钟，期间不会改动任何项目。可以先关闭，生成不会中断。</span>
            </span>
          </div>
          <div className="modal-actions"><button type="button" onClick={onClose}>关闭</button></div>
        </>
      );
    }
    if (p.status === 'failed') {
      return (
        <>
          <p role="alert" className="merge-callout is-bad">{`没有生成预览，项目未做任何改动：${p.error ?? '未知原因'}`}</p>
          <div className="modal-actions">{again}{back}<button type="button" onClick={onClose}>关闭</button></div>
        </>
      );
    }
    if (p.stale || p.changes === null || p.draft === null) {
      return (
        <>
          <p role="alert" className="merge-callout is-bad">{p.status === 'applied' ? '这份预览已经应用过了。' : '生成预览后，项目、关联或会话内容发生了变化，这份预览已过期，不能再确认。'}</p>
          <div className="modal-actions">{p.status === 'applied' ? null : again}<button type="button" onClick={onClose}>关闭</button></div>
        </>
      );
    }
    const { changes, draft } = p;
    return (
      <>
        <p className="merge-summary">
          {changes.source_merged ? `整个项目「${p.source.title}」` : `「${p.source.title}」中的 ${p.sessions.length} 个 session`}
          <span aria-hidden="true"> → </span>
          {`「${p.target.title}」`}
        </p>
        <section aria-label="项目草稿" className="merge-section">
          <h3>{`目标项目「${p.target.title}」将变为`}</h3>
          <dl className="merge-draft">
            {(Object.keys(FIELD_LABEL) as Array<keyof typeof FIELD_LABEL>).map((field) => {
              const change = changes.fields.find((f) => f.field === field);
              const empty = draft[field] === '';
              return (
                <div key={field} className={change === undefined ? 'merge-field-card same' : 'merge-field-card'}>
                  <dt>
                    {FIELD_LABEL[field]}
                    {change === undefined ? <span className="tag">{empty ? '保留现在的内容' : '与现在相同'}</span> : <span className="tag merge-tag-new">改写</span>}
                    {change?.locked ? <span className="tag merge-tag-warn">你锁定过</span> : null}
                  </dt>
                  <dd>
                    <div className="merge-after">{empty ? '（证据不足，草稿没有写这一项）' : draft[field]}</div>
                    {change === undefined ? null : <div className="merge-before">{`现在：${change.before ?? '（空）'}`}</div>}
                    {field === 'title' && draft.title_change_reason ? <div className="merge-reason">{`改名原因：${draft.title_change_reason}`}</div> : null}
                    {change?.locked ? (
                      <label className="merge-locked">
                        <input type="checkbox" checked={overwrite.includes(field)} onChange={() => setOverwrite(toggle(overwrite, field))} />
                        <span>{`你锁定过「${FIELD_LABEL[field]}」。勾选才会用上面的草稿替换；不勾选则保留现在的内容`}</span>
                      </label>
                    ) : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          {draft.unknowns.length > 0 ? (
            <div className="merge-callout">
              <h4>证据没有说明的事</h4>
              <ul>{draft.unknowns.map((u) => <li key={u}>{u}</li>)}</ul>
            </div>
          ) : null}
        </section>
        <section aria-label="关联变化" className="merge-section">
          <h3>关联变化</h3>
          <ul className="merge-rows">
            {changes.links.map((l) => (
              <li key={l.session}>
                <span className="merge-session-name">{name(l.session)}</span>
                <span className="merge-row-tags">
                  <span className={l.target === 'keep' ? 'tag' : 'tag merge-tag-new'}>
                    {l.target === 'keep' ? '目标项目已关联，不重复添加' : l.target === 'restore_vetoed' ? '恢复你之前从目标项目取消的关联' : l.target === 'restore' ? '恢复与目标项目的关联' : '关联到目标项目'}
                  </span>
                  <span className={l.source === 'remove' ? 'tag merge-tag-warn' : 'tag'}>{l.source === 'remove' ? '从本项目移出' : '在本项目的记录中保留'}</span>
                </span>
              </li>
            ))}
          </ul>
          <p>
            {changes.source_merged
              ? `本项目「${p.source.title}」将标记为「已合并」并指向目标项目，它的里程碑、todo、决策保留在原处供查看。`
              : `本项目「${p.source.title}」保留，阶段不变，仍有 ${changes.source_remaining_sessions.length} 个 session。它的标题和描述此时不改；确认后整理员会按剩余内容重新整理它，改动锁定字段前仍会先问你。`}
          </p>
          {!changes.source_merged && changes.source_remaining_sessions.length === 0 ? (
            <p role="note" className="merge-callout is-warn">本项目的 session 将全部移走，但它不会被标记为「已合并」。要合并整个项目，请返回选择「整个项目」。</p>
          ) : null}
        </section>
        <section aria-label="证据范围" className="merge-section">
          <h3>证据范围</h3>
          <p className="dim">{`草稿依据中心保存的会话内容（不是 agent 机器上的原始 transcript），共调用模型 ${p.coverage?.model_calls ?? 0} 次${p.coverage?.mode === 'condensed' ? '，内容较长，先分段提取事实再汇总' : ''}。`}</p>
          <ul className="merge-rows">
            {(p.coverage?.sessions ?? []).map((s) => (
              <li key={s.session_key}>
                <span className="merge-session-name">
                  {name(s.session_key)}
                  <span className="dim">{`（${s.side === 'target' ? '目标项目已有' : s.side === 'both' ? '两边都有' : '本次并入'}）`}</span>
                </span>
                <span className="merge-row-tags">
                  <span className={s.status === 'read' ? 'tag merge-tag-ok' : 'tag merge-tag-warn'}>
                    {COVERAGE_LABEL[s.status]}
                    {s.status === 'read' || s.status === 'partial' ? `，${s.chunks_read}/${s.chunks_total} 段` : ''}
                  </span>
                  {s.refused_chunks ? <span className="tag merge-tag-warn">{`拒摘 ${s.refused_chunks} 段`}</span> : null}
                  {s.refusal_needs_review ? <span className="tag merge-tag-warn">旧拒摘记录待核对</span> : null}
                  {s.truncated_chunks > 0 ? <span className="tag merge-tag-warn">{`其中 ${s.truncated_chunks} 段有消息在采集时已被截断`}</span> : null}
                  {s.excerpted_chunks > 0 ? <span className="tag">{`${s.excerpted_chunks} 段是较长事件的节选`}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {gaps.length > 0 ? <p role="note" className="merge-callout is-warn">{`有 ${gaps.length} 个 session 的内容不完整或未读取，草稿没有包含其中的信息。`}</p> : null}
        </section>
        <details className="merge-after-apply">
          <summary>确认之后会发生什么</summary>
          <ul>
            <li>写入的标题、简介等视为你确认过的内容：AI 之后要改它们会先问你（撤销合并会恢复原文字，但这些字段仍保持由你确认的状态）。</li>
            <li>目标项目的里程碑与 todo 由整理员按合并后的全部 session 重新整理。</li>
            <li>整个合并可在事件记录里一键撤销。</li>
          </ul>
        </details>
        <form className="modal-actions" onSubmit={(e) => { e.preventDefault(); void apply(); }}>
          <button type="submit" disabled={busy}>确认合并</button>
          {again}
          {back}
          <button type="button" onClick={onClose}>取消</button>
        </form>
      </>
    );
  };

  const step = preview === null ? 1 : 2;
  return (
    <Dialog title="合并项目" className="merge-dialog" onClose={onClose} locked={busy}>
      <header className="merge-head">
        <h2>{`合并「${project.title}」`}</h2>
        <ol className="merge-steps" aria-label="步骤">
          <li aria-current={step === 1 ? 'step' : undefined}>选择范围</li>
          <li aria-current={step === 2 ? 'step' : undefined}>预览并确认</li>
        </ol>
      </header>
      {preview === null ? choose : result(preview)}
    </Dialog>
  );
}
