import { useState } from 'react';
import type { FormEvent } from 'react';
import type { QuestionView } from '../../../src/domain/read.ts';
import { apiSend, errorText } from '../api.ts';
import { describeOption } from '../format.ts';
import { useInbox } from '../inbox.tsx';
import { EvidenceLink } from './evidence-drawer.tsx';

/**
 * One question to the user. The buttons only say which option (or what text) was picked; whether that is still allowed
 * is the server's call, and a refusal is shown here in words. `onDone` runs once the server has accepted the answer or
 * the dismissal.
 */
const KIND_LABEL: Record<QuestionView['kind'], string> = { confirm: '是 / 否', choice: '选择', text: '需要你说明' };
const WHY_LABEL: Record<NonNullable<QuestionView['why_user']>, string> = {
  user_authority: '需要你拍板',
  conflict: '你的指示有冲突',
  risk: '有风险',
  missing_information: '缺少信息',
};

export function QuestionCard({ question, projectTitle, onDone }: { question: QuestionView; projectTitle?: string; onDone?: () => void }) {
  const inbox = useInbox();
  const [busy, setBusy] = useState(false);
  // Once the server took the answer the question is no longer pending: keep the card shut until the list drops it.
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const disabled = busy || resolved;
  const answer = text.trim();

  const send = async (action: 'answer' | 'dismiss', body?: unknown) => {
    setBusy(true);
    setError(null);
    let ok = false;
    try {
      await apiSend('POST', `/questions/${encodeURIComponent(question.id)}/${action}`, body);
      ok = true;
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
    if (ok) {
      setResolved(true);
      inbox?.reload();
      onDone?.();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (answer !== '' && !disabled) void send('answer', { text: answer });
  };

  const recommended = question.recommended;
  const yes = question.options[0];
  const recommendLine =
    recommended !== null && question.options[recommended] !== undefined ? (
      <div className="q-recommend">
        <span className="q-recommend-tag">AI 建议</span>
        {question.kind === 'confirm' ? (recommended === 0 ? '是' : '否') : question.options[recommended]!.label}
        {question.recommend_reason ? <span className="dim">{`：${question.recommend_reason}`}</span> : null}
      </div>
    ) : null;

  return (
    <div className={`q q-${question.kind}`} data-question-id={question.id}>
      <div className="q-head">
        <span className="q-kind">{KIND_LABEL[question.kind]}</span>
        {question.why_user ? <span className="q-why">{WHY_LABEL[question.why_user]}</span> : null}
        {projectTitle ? <span className="q-project">{projectTitle}</span> : null}
      </div>
      {question.context ? <div className="q-context">{question.context}</div> : null}
      <div className="q-prompt">{question.prompt}</div>
      {recommendLine}
      {question.kind === 'text' ? (
        <form className="q-text" onSubmit={submit}>
          <input type="text" aria-label="你的回答" placeholder="输入回答" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} />
          <button
            type="submit"
            // A text question runs its first option with the typed text filled in.
            title={question.options.length > 0 ? describeOption(question.options[0]) : undefined}
            disabled={disabled || answer === ''}
          >
            提交
          </button>
        </form>
      ) : question.kind === 'confirm' && question.options.length === 2 ? (
        <>
          {yes && (yes.detail || yes.label !== '确认') ? (
            <div className="q-effect">{`选「是」将：${[yes.label !== '确认' ? yes.label : null, yes.detail].filter(Boolean).join('，')}`}</div>
          ) : null}
          <div className="q-options q-yesno">
            {question.options.map((option, index) => (
              <button
                key={index}
                type="button"
                className={index === 0 ? 'q-yes' : 'q-no'}
                title={describeOption(option)}
                disabled={disabled}
                aria-describedby={recommended === index ? `${question.id}-rec` : undefined}
                onClick={() => void send('answer', { option_index: index })}
              >
                {index === 0 ? '是' : '否'}
              </button>
            ))}
            {recommended !== null ? <span id={`${question.id}-rec`} className="visually-hidden">AI 建议的选项</span> : null}
          </div>
        </>
      ) : (
        <ul className="q-options q-choices">
          {question.options.map((option, index) => (
            <li key={index} className={recommended === index ? 'is-recommended' : undefined}>
              <button type="button" title={describeOption(option)} disabled={disabled} onClick={() => void send('answer', { option_index: index })}>
                {option.label}
              </button>
              {option.detail ? <span className="q-detail">{option.detail}</span> : null}
              {recommended === index ? <span className="q-badge">建议</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="q-foot">
        <button type="button" className="linklike" disabled={disabled} onClick={() => void send('dismiss')}>
          忽略
        </button>
        {question.evidence.length > 0 ? (
          <span className="evidence">
            {question.evidence.map((ref, index) => (
              <EvidenceLink key={`${index}:${ref}`} evidence={ref} />
            ))}
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <div className="q-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
