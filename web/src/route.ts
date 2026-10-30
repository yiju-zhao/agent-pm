// In-page routing uses the URL hash (`#/`, `#/p/<id>`, `#/sessions`), so the server needs no route besides `/`.

export type Route = { page: 'home' } | { page: 'project'; id: string } | { page: 'sessions' };

/** Anything not recognised is the home page. */
export function parseHash(hash: string): Route {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (path === '/sessions' || path === '/sessions/') return { page: 'sessions' };
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
