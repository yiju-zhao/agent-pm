import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export const TOAST_MS = 4000;

type Toast = { id: number; text: string };

const ToastContext = createContext<(text: string) => void>(() => {});

/** `toast(text)` shows a short message for a few seconds. The text can be selected and copied. */
export function useToast(): (text: string) => void {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const show = useCallback((text: string) => {
    const id = nextId.current++;
    setToasts((all) => [...all, { id, text }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((all) => all.filter((t) => t.id !== id));
    }, TOAST_MS);
    timers.current.add(timer);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
