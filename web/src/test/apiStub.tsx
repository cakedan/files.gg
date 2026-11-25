import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';

import { routes } from '../app/routes';
import type { User } from '../lib/api';
import { createQueryClient } from '../lib/queryClient';
import { sessionUser } from './session';

export { ME, signIn, signOut } from './session';

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface StubRequest {
  /** The request URL with the `/api` base removed from its path. */
  url: URL;
  method: string;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

/** The same-origin `/api` base is stripped, so tables use the API's own paths. */
export function apiUrl(input: RequestInfo | URL): URL {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) url.pathname = url.pathname.slice(4) || '/';
  return url;
}

export type StubHandler = (request: StubRequest) => unknown;

/**
 * Stubs `fetch` with `"METHOD /path/:param"` routes. A handler returns a body (sent as
 * 200 JSON) or a Response. Anything unmatched is a 404 like the API's.
 *
 * `GET /auth/session` answers by itself unless the table has it: `{ user: null }` signed
 * out; signed in (`signIn()`), the table's `GET /users/@me` answer when it has one, else
 * the signed-in user. Paths are matched below the `/api` base.
 */
export function stubApi(routeTable: Record<string, StubHandler>) {
  const table: Record<string, StubHandler> = { ...routeTable };
  if (!table['GET /auth/session']) {
    const me = routeTable['GET /users/@me'];
    table['GET /auth/session'] = async (request) => ({ user: sessionUser() ? ((me ? await me(request) : sessionUser()) as User) : null });
  }
  const compiled = Object.entries(table).map(([pattern, handler]) => {
    const [method, path] = pattern.split(' ') as [string, string];
    return { method, regex: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`), handler };
  });
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = apiUrl(input);
    const method = init?.method ?? 'GET';
    const route = compiled.find((each) => each.method === method && each.regex.test(url.pathname));
    if (!route) return jsonResponse({ code: 'NOT_FOUND', message: 'Not found', status: 404 }, 404);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const out = await route.handler({ url, method, body, headers: new Headers(init?.headers) });
    return out instanceof Response ? out : jsonResponse(out ?? {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Calls of the stub, as `METHOD /path?query`. */
export const calls = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([input, init]) => {
      const url = apiUrl(input);
      return {
        method: init?.method ?? 'GET',
        path: url.pathname,
        search: url.searchParams,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
      };
    })
    // The session check is the layout's, not the page's.
    .filter((call) => call.path !== '/auth/session');

/** The whole dashboard (layout, routes, Toaster) at `path`. */
export function renderDashboard(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

export const NO_BADGES = { reports_unread: 0, notices_unacknowledged: 0, restrictions: [], staff: null };
