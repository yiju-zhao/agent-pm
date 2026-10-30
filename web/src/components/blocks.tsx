import { useId, useState } from 'react';
import type { ReactNode } from 'react';

/** A titled part of a page. The title names the region. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="block" aria-labelledby={id}>
      <h3 id={id} className="h">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A shut-by-default group. What is inside is not rendered until it is opened. */
export function Fold({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="fold">
      <button type="button" className="fold-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">{open ? '▾ ' : '▸ '}</span>
        {label}
      </button>
      {open ? <div>{children}</div> : null}
    </section>
  );
}
