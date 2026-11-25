import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv, searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

import { MOCK_API_PREFIX } from './mock-api.ts';
import { markdown } from './plugins/markdown.ts';
import { devFixtures, mockApi, pdfjsAssets, routeEntries } from './vite.plugins.ts';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** milestone-5 §19.1: the changelog lives at the repo root, the legal pages in src/content/legal. */
const CHANGELOG = resolve('../CHANGELOG.md');
/** §19.6: a production build fails while these still have placeholders. */
const LEGAL_PAGES = [resolve('./src/content/legal/terms.md'), resolve('./src/content/legal/privacy.md')];

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // `npm run dev` talks to the in-memory mock API unless VITE_API_URL points elsewhere.
  const useMock = command === 'serve' && mode !== 'test' && !env.VITE_API_URL;
  if (command === 'build' && !env.VITE_TURNSTILE_SITE_KEY) {
    console.warn('\n[files.gg] VITE_TURNSTILE_SITE_KEY is not set: Turnstile (unlock, anonymous uploads) will fail in this build.\n');
  }
  return {
    define: useMock ? { 'import.meta.env.VITE_API_URL': JSON.stringify(MOCK_API_PREFIX) } : {},
    plugins: [
      markdown({ strict: LEGAL_PAGES }),
      routeEntries(),
      devFixtures(),
      pdfjsAssets(),
      ...(useMock ? [mockApi()] : []),
      react(),
      tailwindcss(),
    ],
    // The dev server may read CHANGELOG.md, outside web/.
    server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), CHANGELOG] } },
    build: {
      target: 'es2022',
      sourcemap: true,
      rolldownOptions: {
        input: {
          viewer: resolve('./viewer.html'),
          app: resolve('./app.html'),
          // milestone-6 §10.10: files.gg/challenge, the Turnstile frame for custom domains. No React.
          challenge: resolve('./challenge.html'),
        },
        output: {
          codeSplitting: {
            groups: [
              // React is shared by both entries; give it a stable, long-cacheable chunk.
              // Only modules both entries need may go in a shared group, so the viewer
              // never downloads dashboard dependencies.
              { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            ],
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      restoreMocks: true,
      unstubGlobals: true,
    },
  };
});
