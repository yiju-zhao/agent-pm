import { useEffect, useRef, useState } from 'react';

/** How long the second click stays welcome. */
export const CONFIRM_MS = 3000;

/**
 * A button for things that cannot be taken back. The first click only changes the label to `confirmLabel`; a second
 * click within 3 seconds runs `onConfirm`, otherwise the button goes back to `label`. This is on the page itself, not the
 * browser's confirm dialog. A refusal is `onConfirm`'s to show (it should not leave a rejection to us): here it only
 * ends the waiting.
 */
export function ConfirmButton({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm(): Promise<void> }) {
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const click = () => {
    if (!asked) {
      setAsked(true);
      timer.current = setTimeout(() => setAsked(false), CONFIRM_MS);
      return;
    }
    clearTimeout(timer.current);
    setAsked(false);
    setBusy(true);
    void (async () => {
      try {
        await onConfirm();
      } catch {
        // Shown by whoever passed onConfirm.
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <button type="button" className={asked ? 'danger asked' : 'danger'} disabled={busy} onClick={click}>
      {asked ? confirmLabel : label}
    </button>
  );
}
