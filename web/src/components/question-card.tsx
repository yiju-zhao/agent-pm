import { useState } from 'react';
import type { FormEvent } from 'react';
import type { QuestionView } from '../../../src/domain/read.ts';
import { apiSend, errorText } from '../api.ts';
import { describeOption } from '../format.ts';
import { EvidenceLink } from './evidence-drawer.tsx';

/**
 * One question to the user. The buttons only say which option (or what text) was picked; whether that is still allowed
 * is the server's call, and a refusal is shown here in words. `onDone` runs once the server has accepted the answer or
 * the dismissal.
 */
export function QuestionCard({ question, projectTitle, onDone }: { question: QuestionView; projectTitle?: string; onDone?: () => void }) {
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
      onDone?.();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (answer !== '' && !disabled) void send('answer', { text: answer });
  };

  return (
    <div className="q" data-question-id={question.id}>
      {projectTitle ? <div className="dim">{projectTitle}</div> : null}
      <div className="q-prompt">{question.prompt}</div>
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
      ) : (
        <div className="q-options">
          {question.options.map((option, index) => (
            <button
              key={index}
              type="button"
              title={describeOption(option)}
              disabled={disabled}
              onClick={() => void send('answer', { option_index: index })}
            >
              {option.label}
            </button>
          ))}
        </div>
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
