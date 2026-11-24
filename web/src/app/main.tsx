import '../styles/app.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { createQueryClient } from '../lib/queryClient';
import { APP_BASENAME, routes } from './routes';

const root = document.getElementById('root');
if (!root) throw new Error('files.gg dashboard: #root is missing');

const queryClient = createQueryClient();
const router = createBrowserRouter(routes, { basename: APP_BASENAME });

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
