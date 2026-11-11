/** The two icons the app draws itself, as inline SVG on the text colour: a warning triangle and a blocked sign. */
const PATHS = {
  warning: 'M8 1.5 15 14H1L8 1.5Zm0 4.5v4m0 2v.5',
  blocked: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM3.5 12.5l9-9',
} as const;

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
