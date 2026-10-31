import { useState } from 'react';
import type { ProjectDetail } from '../../../src/domain/read.ts';
import { STAGES, STAGE_LABEL } from '../../../src/shared/vocab.ts';
import type { Stage } from '../../../src/shared/vocab.ts';
import { apiSend } from '../api.ts';
import { useWrite } from '../use-write.ts';

/**
 * Where the project is, and the way to move it. Every stage but the current one is offered, none picked until the person
 * picks one; whether the move is allowed is the server's call and a refusal is shown as a toast. Merging asks for the
 * project to merge into: `mergeTargets` is undefined while that list is on its way (or, with `mergeTargetsFailed`, could
 * not be read). `reload` runs after a move has been accepted.
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
  const options = STAGES.filter((s) => s !== project.stage);
  const [picked, setPicked] = useState<Stage | ''>('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  // The stage that was picked may have become the current one (the move went through): then nothing is picked again.
  const stage = picked !== '' && options.includes(picked) ? picked : '';
  const targets = (mergeTargets ?? []).filter((t) => t.id !== project.id);
  const merging = stage === 'merged';
  const ready = stage !== '' && (!merging || targets.some((t) => t.id === target));
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
      <span className="dim">{`当前阶段：${STAGE_LABEL[project.stage]}`}</span>
      <select aria-label="新阶段" value={stage} onChange={(e) => setPicked(e.target.value as Stage | '')}>
        <option value="">选择阶段…</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABEL[s]}
          </option>
        ))}
      </select>
      {merging ? targetMenu : null}
      <button
        type="button"
        disabled={busy || !ready}
        onClick={() => {
          if (stage !== '') void move(merging ? { stage, merge_into: target } : { stage });
        }}
      >
        确定
      </button>
      {resume !== null ? (
        <button type="button" disabled={busy} onClick={() => void move({ stage: resume })}>
          {`恢复到 ${STAGE_LABEL[resume]}`}
        </button>
      ) : null}
    </span>
  );
}
