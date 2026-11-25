import { createContext } from 'react';

/**
 * Some dashboard pieces also run on the public pages outside /app (the Convert page at `files.gg/convert`,
 * the upload box on the home page), under the public router. True in the dashboard's router (the default);
 * false there, where dashboard paths are plain links to `/app/…` (`AppLink`).
 */
export const InDashboardContext = createContext(true);
