const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Formats a byte count with binary multiples (1 KB = 1024 B), like the old app. */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
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
