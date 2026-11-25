import '../styles/viewer.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { takeFragmentSecrets } from '../lib/access';
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

  // Read #pw= / #t= and strip them from the address bar before anything renders.
  const secrets = takeFragmentSecrets();
  const state = parseBoot(readBootInput());
  createRoot(root).render(
    <StrictMode>
      <ViewerApp state={state} secrets={secrets} />
    </StrictMode>,
  );
}

void boot();
