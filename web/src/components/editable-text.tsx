import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { errorText } from '../api.ts';

const LOCKED_TEXT = '你改过这个字段，AI 不会再改它';
const UNLOCK_TEXT = '解锁后 AI 可以修改这个字段';

/**
 * 🔒 beside a field the user has edited (the AI will not change it any more) and, when `onUnlock` is given, the button
 * that gives it back. `field` names the field when the mark does not stand right beside it. A refused unlock goes to `onError`.
 */
export function LockMark({ field, onUnlock, onError }: { field?: string; onUnlock?: () => Promise<unknown>; onError?: (err: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const unlock = async () => {
    if (onUnlock === undefined) return;
    setBusy(true);
    try {
      await onUnlock();
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="lock-mark">
      <span className="lock" title={LOCKED_TEXT}>
        🔒
      </span>
      {field !== undefined ? <span className="dim">{field}</span> : null}
      {onUnlock !== undefined ? (
        <button type="button" className="linklike" title={UNLOCK_TEXT} aria-label={field !== undefined ? `解锁${field}` : undefined} disabled={busy} onClick={unlock}>
          解锁
        </button>
      ) : null}
    </span>
  );
}

type EditableTextProps = {
  value: string | null;
  /** The user has edited this field: it shows 🔒 and, with `onUnlock`, 解锁. */
  locked: boolean;
  /** A text area (saved with Cmd/Ctrl+Enter) instead of a single line (saved with Enter). */
  multiline?: boolean;
  /** Shown, dimmed, while the value is empty. */
  placeholder?: string;
  /** Saves the trimmed text. A rejection keeps the field open and its reason is shown beside it. */
  onSave(value: string): Promise<void>;
  onUnlock?(): Promise<void>;
};

/**
 * Text that turns into an input when clicked. Enter (single line) or Cmd/Ctrl+Enter (several lines) or 保存 saves it,
 * Esc or 取消 puts it back as it was. Nothing is sent when the text did not change. The typed text is never replaced by
 * a newer `value` while it is being edited.
 */
export function EditableText({ value, locked, multiline = false, placeholder, onSave, onUnlock }: EditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const sending = useRef(false);
  const wasEditing = useRef(false);

  // Into the field with the caret at the end; out of it back onto the text.
  useEffect(() => {
    if (editing) {
      const el = field.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    } else if (wasEditing.current) {
      trigger.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  const start = () => {
    setDraft(value ?? '');
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    if (sending.current) return;
    const next = draft.trim();
    if (next === (value ?? '').trim()) {
      cancel();
      return;
    }
    sending.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      sending.current = false;
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // The Enter that picks a candidate in a Chinese input method must not save (Safari reports it as keyCode 229).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter' && (multiline ? e.metaKey || e.ctrlKey : !e.shiftKey)) {
      e.preventDefault();
      void save();
    }
  };

  const onChange = (text: string) => {
    setDraft(text);
    setError(null);
  };

  return (
    <span className="editable">
      {editing ? (
        <span className="edit-box">
          {multiline ? (
            <textarea
              ref={(el) => {
                field.current = el;
              }}
              value={draft}
              rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))}
              readOnly={saving}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
            />
          ) : (
            <input
              type="text"
              ref={(el) => {
                field.current = el;
              }}
              value={draft}
              readOnly={saving}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
            />
          )}
          <span className="edit-actions">
            <button type="button" disabled={saving} onClick={() => void save()}>
              保存
            </button>
            <button type="button" disabled={saving} onClick={cancel}>
              取消
            </button>
          </span>
        </span>
      ) : (
        <button type="button" ref={trigger} className="editable-text" onClick={start}>
          {value ? value : <span className="placeholder">{placeholder ?? '（空）'}</span>}
        </button>
      )}
      {locked ? <LockMark onUnlock={onUnlock} onError={(err) => setError(errorText(err))} /> : null}
      {error !== null ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
