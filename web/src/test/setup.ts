import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { signOut } from './session';

// jsdom has no ResizeObserver; layout-dependent components only need it to exist.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  // Every test starts signed out, and the client forgets its last `GET /auth/session` answer.
  signOut();
});
