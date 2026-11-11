import { useState } from 'react';
import type { ProjectDetail } from '../../../src/domain/read.ts';
import { STAGES, STAGE_LABEL } from '../../../src/shared/vocab.ts';
import type { Stage } from '../../../src/shared/vocab.ts';
import { apiSend } from '../api.ts';
import { useWrite } from '../use-write.ts';

/**
 * Who a fixed-choice field's value came from: pre-filled by the AI (the person changes it in place, in the same control)
 * or set by the person. Nothing while the field has no value.
 */
export function SourceMark({ source }: { source: 'ai' | 'user' | null }) {
  if (source === null) return null;
  return source === 'ai' ? (
    <span className="field-source ai" title="AI 根据对话预填的值，直接在这里改即可">
      AI 预填
    </span>
  ) : (
    <span className="field-source user" title="你设定或确认过的值">
      你定的
    </span>
  );
}

/**
 * The project's stage as one field: the menu shows the current stage, and picking another one only proposes it; it moves
 * when confirmed (确定), and 取消 puts the menu back. Whether a move is allowed is the server's call, and a refusal is
 * shown as a toast with the pick kept. Merging asks for the project to merge into: `mergeTargets` is undefined while
 * that list is on its way (or, with `mergeTargetsFailed`, could not be read). `reload` runs after a move was accepted.
 */
export function StageControl({
  project,
  mergeTargets,
  mergeTargetsFailed = false,
  reload,
}: {
  project: ProjectDetail;
  mergeTargets: Array<{ id: string; title: string }> | undefined;
  mergeTargetsFailed?: boolean;
  reload?: () => void;
}) {
  const { fire } = useWrite(reload);
  const [picked, setPicked] = useState<Stage | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  // A pick that became the current stage (the move went through) is no longer pending.
  const pending = picked !== null && picked !== project.stage ? picked : null;
  const targets = (mergeTargets ?? []).filter((t) => t.id !== project.id);
  const merging = pending === 'merged';
  const ready = pending !== null && (!merging || targets.some((t) => t.id === target));
  const path = `/projects/${encodeURIComponent(project.id)}/stage`;
  const resume = project.stage === 'parked' ? project.stage_before_park : null;

  const move = async (body: { stage: Stage; merge_into?: string }) => {
    setBusy(true);
    await fire(() => apiSend('POST', path, body));
    setBusy(false);
  };

  const targetMenu =
    mergeTargets === undefined ? (
      <span className="dim">{mergeTargetsFailed ? '读不到项目列表' : '加载中…'}</span>
    ) : targets.length === 0 ? (
      <span className="dim">没有可以合并进去的项目</span>
    ) : (
      <select aria-label="合并到" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">选择目标项目</option>
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
    );

  return (
    <span className="stage-control">
      <label className="field-label">
        阶段
        <select
          aria-label="阶段"
          className={pending !== null ? 'pending' : undefined}
          value={pending ?? project.stage}
          onChange={(e) => setPicked(e.target.value as Stage)}
        >
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {pending === null ? <SourceMark source={project.field_sources.stage} /> : null}
      {merging ? targetMenu : null}
      {pending !== null ? (
        <>
          <span className="dim">{`${STAGE_LABEL[project.stage]} → ${STAGE_LABEL[pending]}`}</span>
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() => void move(merging ? { stage: pending, merge_into: target } : { stage: pending })}
          >
            确定
          </button>
          <button type="button" disabled={busy} onClick={() => setPicked(null)}>
            取消
          </button>
        </>
      ) : null}
      {resume !== null && pending === null ? (
        <button type="button" disabled={busy} onClick={() => void move({ stage: resume })}>
          {`恢复到 ${STAGE_LABEL[resume]}`}
        </button>
      ) : null}
    </span>
  );
}
