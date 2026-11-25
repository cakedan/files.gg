export type StorageTone = 'ok' | 'warn' | 'danger' | 'full';

/** The storage meter's colour: amber at 80%, red at 95%, and "full" (uploads blocked) at 100%. */
export function storageTone(used: number, limit: number): StorageTone {
  const ratio = limit > 0 ? used / limit : 0;
  if (ratio >= 1) return 'full';
  if (ratio >= 0.95) return 'danger';
  if (ratio >= 0.8) return 'warn';
  return 'ok';
}
