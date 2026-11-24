import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { devFixtures, pdfjsAssets, routeEntries } from './vite.plugins.ts';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [routeEntries(), devFixtures(), pdfjsAssets(), react(), tailwindcss()],
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
});
