const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Formats a byte count with decimal multiples (1 KB = 1000 B, 1 MB = 1,000,000 B), as the API's limits are
 * configured (api/utils/limits.py), so "100 MB" means the same number of bytes in both.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  let exponent = Math.min(Math.floor(Math.log10(bytes) / 3), BYTE_UNITS.length - 1);
  // 999,950 B is "1 MB", not "1000 KB"
  if (exponent > 0 && exponent < BYTE_UNITS.length - 1 && Number((bytes / 1000 ** exponent).toFixed(decimals)) >= 1000) exponent += 1;
  const value = bytes / 1000 ** exponent;
  const unit = BYTE_UNITS[exponent] ?? 'B';
  if (exponent === 0) {
    return `${bytes} ${unit}`;
  }
  return `${Number(value.toFixed(decimals))} ${unit}`;
}

export function formatDimensions(width?: number | null, height?: number | null): string | null {
  if (!width || !height) {
    return null;
  }
  return `${width}×${height}`;
}
