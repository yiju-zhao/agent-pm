import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** Native modal semantics provide focus containment and make the page behind it inert. */
export function Dialog({ title, children, onClose, className = '', locked = false }: {
  title: string; children: ReactNode; onClose(): void; className?: string; locked?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={ref} aria-label={title} className={`modal app-dialog ${className}`}
    onCancel={(event) => { event.preventDefault(); if (!locked) onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget || locked) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}>
    {children}
  </dialog>;
}
