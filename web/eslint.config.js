import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist', 'coverage', 'public', 'fixtures']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The viewer bundle must stay small: it may never pull in dashboard code,
    // the router, TanStack Query or the API client.
    files: ['src/viewer/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/app/**', '../app', '../../app'], message: 'The viewer must not import dashboard code.' },
            { group: ['**/lib/api', '**/lib/queries', '**/lib/queryClient'], message: 'The viewer boots from inlined JSON and must not import the API client.' },
          ],
          paths: [
            { name: 'react-router', message: 'The viewer must not import the router.' },
            { name: '@tanstack/react-query', message: 'The viewer must not import TanStack Query.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['vite.config.ts', 'vite.plugins.ts', 'eslint.config.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
]);
