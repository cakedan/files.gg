/**
 * "Always show sensitive media" (milestone-4 §4.6): one setting for the viewer, the
 * album page and the dashboard, kept in `localStorage["filesgg.showSensitive"] = "1"`.
 */

import { getItem, removeItem, setItem } from './storage';

export const SHOW_SENSITIVE_KEY = 'filesgg.showSensitive';

export const alwaysShowSensitive = (): boolean => getItem(SHOW_SENSITIVE_KEY) === '1';

export function setAlwaysShowSensitive(value: boolean): void {
  if (value) setItem(SHOW_SENSITIVE_KEY, '1');
  else removeItem(SHOW_SENSITIVE_KEY);
}
