import type { PasswordExpiryValue } from '../../lib/upload/options';

export const fieldClass = 'h-9 rounded-md border border-line bg-bg px-2 text-sm text-text disabled:opacity-50';

/** <select> values are strings; expiry values are 'never' | 'custom' | seconds. */
export const encodeChoice = (value: string | number) => String(value);
export const decodeChoice = (value: string): PasswordExpiryValue => (value === 'never' || value === 'custom' ? value : Number(value));

export function toLocalInput(ms: number | null): string {
  if (ms === null) return '';
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}
