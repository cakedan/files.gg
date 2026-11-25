import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';

import { routes } from '../app/routes';
import { createQueryClient } from '../lib/queryClient';

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface StubRequest {
  url: URL;
  method: string;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type StubHandler = (request: StubRequest) => unknown;

/**
 * Stubs `fetch` with `"METHOD /path/:param"` routes. A handler returns a body (sent as
 * 200 JSON) or a Response. Anything unmatched is a 404 like the API's.
 */
export function stubApi(routeTable: Record<string, StubHandler>) {
  const compiled = Object.entries(routeTable).map(([pattern, handler]) => {
    const [method, path] = pattern.split(' ') as [string, string];
    return { method, regex: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`), handler };
  });
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const route = compiled.find((each) => each.method === method && each.regex.test(url.pathname));
    if (!route) return jsonResponse({ code: 'NOT_FOUND', message: 'Not found', status: 404 }, 404);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const out = await route.handler({ url, method, body });
    return out instanceof Response ? out : jsonResponse(out ?? {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Calls of the stub, as `METHOD /path?query`. */
export const calls = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.map(([input, init]) => {
    const url = new URL(String(input));
    return { method: init?.method ?? 'GET', path: url.pathname, search: url.searchParams, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
  });

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

export const ME = { id: '42', username: 'mockuser', display_name: 'Mock User', flags: 0, email: 'mock@example.com', verified: true, staff: null, restrictions: [] };
export const NO_BADGES = { reports_unread: 0, notices_unacknowledged: 0, restrictions: [], staff: null };
