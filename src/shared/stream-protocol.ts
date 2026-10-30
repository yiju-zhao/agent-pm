// The messages of `WS /stream`. Shared by the server and the browser bundle: no imports, so it can run anywhere.
// The stream only says *what* changed; the page then re-reads the matching HTTP endpoint. A cross-site page that
// manages to connect therefore learns nothing but the fact that something changed (and the Origin check stops that too).

/** One new event row, enough for the page to know which project to re-read. */
export type StreamEvent = { id: number; project_id: string | null; op: string; actor: string };

export type StreamMessage =
  /** Always the first message after connecting: the page re-reads everything, catching up on what it missed while away. */
  | { type: 'hello' }
  /** New events, oldest first, at most `STREAM_MAX_EVENTS`; `more` means there were further ones not listed. */
  | { type: 'events'; events: StreamEvent[]; more: boolean }
  | { type: 'questions' }
  | { type: 'sessions' }
  | { type: 'status' };

export const STREAM_MAX_EVENTS = 200;
