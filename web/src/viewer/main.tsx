import '../styles/viewer.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { FragmentSecrets } from '../lib/access';
import { takeFragmentSecrets, watchFragmentSecrets } from '../lib/access';
import { parseBoot, readBootInput } from './boot';
import { ViewerApp } from './ViewerApp';

async function boot() {
  if (import.meta.env.DEV) {
    const { applyFixture, fixtureForPath, isFixtureName } = await import('./fixtures');
    const name = new URLSearchParams(location.search).get('fixture');
    const fixture = isFixtureName(name) ? name : fixtureForPath(location.pathname);
    if (fixture) await applyFixture(fixture);
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('files.gg viewer: #root is missing');

  // Read #pw= / #t= and strip them from the address bar before anything renders.
  const state = parseBoot(readBootInput());
  const reactRoot = createRoot(root);
  let mount = 0;
  const render = (secrets: FragmentSecrets) =>
    reactRoot.render(
      <StrictMode>
        {/* A new key re-mounts the page, so a late #pw= / #t= unlocks like a fresh load. */}
        <ViewerApp key={mount++} state={state} secrets={secrets} />
      </StrictMode>,
    );
  render(takeFragmentSecrets());
  watchFragmentSecrets(render);
}

void boot();
