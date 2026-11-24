import '../styles/viewer.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { parseBoot, readBootInput } from './boot';
import { ViewerApp } from './ViewerApp';

async function boot() {
  if (import.meta.env.DEV) {
    const { applyFixture, fixtureForPath, isFixtureName } = await import('./fixtures');
    const name = new URLSearchParams(location.search).get('fixture');
    const fixture = isFixtureName(name) ? name : fixtureForPath(location.pathname);
    if (fixture) applyFixture(fixture);
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('files.gg viewer: #root is missing');

  const state = parseBoot(readBootInput());
  createRoot(root).render(
    <StrictMode>
      <ViewerApp state={state} />
    </StrictMode>,
  );
}

void boot();
