import { useState } from 'react';
import type { ProjectDetail } from '../../../src/domain/read.ts';
import { STAGES, STAGE_LABEL } from '../../../src/shared/vocab.ts';
import type { Stage } from '../../../src/shared/vocab.ts';
import { apiSend } from '../api.ts';
import { useWrite } from '../use-write.ts';
import { MergeDialog } from './merge-dialog.tsx';

/**
 * The project's stage as one menu: it shows the current stage, and picking another one moves the project at once.
 * Whether a move is allowed is the server's call; a refusal is shown as a toast and the menu stays on the stage the
 * project is in. Merging is not a one-click move: picking 合并 opens the merge dialog (target, whole project or chosen
 * sessions, preview, confirmation), and closing it leaves the project as it was. `mergeTargets` is undefined while that
 * list is on its way (or, with `mergeTargetsFailed`, could not be read). `reload` runs after a move was accepted. A move
 * is taken back from the event log, like any other change.
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
  const [choosingTarget, setChoosingTarget] = useState(false);
  const [busy, setBusy] = useState(false);

  // Once the project is merged there is nothing left to choose.
  const merging = choosingTarget && project.stage !== 'merged';
  const targets = (mergeTargets ?? []).filter((t) => t.id !== project.id);
  const path = `/projects/${encodeURIComponent(project.id)}/stage`;
  const resume = project.stage === 'parked' ? project.stage_before_park : null;

  const move = async (body: { stage: Stage }) => {
    setBusy(true);
    await fire(() => apiSend('POST', path, body));
    setBusy(false);
    setChoosingTarget(false);
  };

  const pick = (stage: Stage) => {
    if (stage === 'merged') setChoosingTarget(true);
    else if (stage === project.stage) setChoosingTarget(false);
    else void move({ stage });
  };

  // The merge itself (target, scope, preview, confirmation) happens in the dialog; here only why it cannot open.
  const targetMenu =
    mergeTargets === undefined ? (
      <span className="dim">{mergeTargetsFailed ? '读不到项目列表' : '加载中…'}</span>
    ) : targets.length === 0 ? (
      <span className="dim">没有可以合并进去的项目</span>
    ) : (
      <MergeDialog project={project} targets={targets} reload={reload} onClose={() => setChoosingTarget(false)} />
    );

  return (
    <span className="stage-control">
      <label className="field-label">
        阶段
        <select aria-label="阶段" value={merging ? 'merged' : project.stage} disabled={busy} onChange={(e) => pick(e.target.value as Stage)}>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {merging ? targetMenu : null}
      {resume !== null && !merging ? (
        <button type="button" disabled={busy} onClick={() => void move({ stage: resume })}>
          {`恢复到 ${STAGE_LABEL[resume]}`}
        </button>
      ) : null}
    </span>
  );
}
