import { useCallback } from 'react';
import { errorText } from './api.ts';
import { useToast } from './components/toast.tsx';

export type Writer = {
  /** Runs `send`, then `reload()`. When it fails the reason is shown in a toast and the error is thrown again, for a caller that keeps a field open. */
  write(send: () => Promise<unknown>): Promise<void>;
  /** The same, for a button: a failure is only shown in the toast, so the returned promise never rejects. */
  fire(send: () => Promise<unknown>): Promise<void>;
};

/**
 * What every write on the project page does around its request. The page also reads again when the server announces
 * the change, but what the user just did must show at once, so a successful write reads the data again itself.
 */
export function useWrite(reload?: () => void): Writer {
  const toast = useToast();
  const write = useCallback(
    async (send: () => Promise<unknown>) => {
      try {
        await send();
      } catch (err) {
        toast(errorText(err));
        throw err;
      }
      reload?.();
    },
    [toast, reload],
  );
  const fire = useCallback((send: () => Promise<unknown>) => write(send).catch(() => {}), [write]);
  return { write, fire };
}
