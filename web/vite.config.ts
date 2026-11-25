import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

import { MOCK_API_PREFIX } from './mock-api.ts';
import { devFixtures, mockApi, pdfjsAssets, routeEntries } from './vite.plugins.ts';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // `npm run dev` talks to the in-memory mock API unless VITE_API_URL points elsewhere.
  const useMock = command === 'serve' && mode !== 'test' && !env.VITE_API_URL;
  if (command === 'build' && !env.VITE_TURNSTILE_SITE_KEY) {
    console.warn('\n[files.gg] VITE_TURNSTILE_SITE_KEY is not set: Turnstile (unlock, anonymous uploads) will fail in this build.\n');
  }
  return {
    define: useMock ? { 'import.meta.env.VITE_API_URL': JSON.stringify(MOCK_API_PREFIX) } : {},
    plugins: [routeEntries(), devFixtures(), pdfjsAssets(), ...(useMock ? [mockApi()] : []), react(), tailwindcss()],
    build: {
      target: 'es2022',
      sourcemap: true,
      rolldownOptions: {
        input: {
          viewer: resolve('./viewer.html'),
          app: resolve('./app.html'),
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
