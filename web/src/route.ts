// In-page routing uses the URL hash (`#/` the command center, `#/projects`, `#/review`, `#/p/<id>`, `#/sessions`, `#/keys`,
// `#/inbox`), so the server needs no route besides `/`.

export type Route = { page: 'home' } | { page: 'projects' } | { page: 'review' } | { page: 'project'; id: string } | { page: 'sessions' } | { page: 'keys' } | { page: 'inbox' };

/** Anything not recognised is the home page. */
export function parseHash(hash: string): Route {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (path === '/sessions' || path === '/sessions/') return { page: 'sessions' };
  if (path === '/projects' || path === '/projects/') return { page: 'projects' };
  if (path === '/review' || path === '/review/') return { page: 'review' };
  if (path === '/keys' || path === '/keys/') return { page: 'keys' };
  if (path === '/inbox' || path === '/inbox/') return { page: 'inbox' };
  const project = /^\/p\/([^/]+)\/?$/.exec(path);
  if (project !== null) {
    try {
      return { page: 'project', id: decodeURIComponent(project[1]) };
    } catch {
      return { page: 'home' };
    }
  }
  return { page: 'home' };
}
