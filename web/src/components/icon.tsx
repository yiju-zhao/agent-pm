/** Small functional icons, drawn on the current text colour. */
const PATHS = {
  projects: 'M2 2h5v5H2V2Zm7 0h5v5H9V2ZM2 9h5v5H2V9Zm7 0h5v5H9V9Z',
  sessions: 'M2 3h12v9H2V3Zm3 3 2 2-2 2m4 0h2',
  key: 'M6.5 9.5a4 4 0 1 1 3-3L14 11v3h-3v-2H9v-2L6.5 9.5Z',
  settings: 'M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0-3v1m0 10v1M2 8h1m10 0h1M3.8 3.8l.7.7m7 7 .7.7m0-8.4-.7.7m-7 7-.7.7',
  sync: 'M13 6A5.2 5.2 0 0 0 3 5m10-3v4H9M3 10a5.2 5.2 0 0 0 10 1M3 14v-4h4',
  list: 'M2 3h1m3 0h8M2 8h1m3 0h8M2 13h1m3 0h8',
  inbox: 'M2 3h12v10H2V3Zm0 6h3l1 2h4l1-2h3M5 5h6M5 7h6',
  board: 'M2 2h4v12H2V2Zm8 0h4v7h-4V2Z',

  console: 'M2 2h12v12H2V2Zm0 4h12M6 6v8',
  review: 'M2 13h12M4 13V8m3 5V4m3 9V7m3 6V2',
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
