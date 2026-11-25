/**
 * Player volume and mute, shared by every player on files.gg (Appendix A, contract §7):
 * `localStorage["filesgg.volume"]` (0–1) and `localStorage["filesgg.muted"]`
 * ("true" / "false"). Storage access goes through lib/storage, which never throws.
 */

import { getItem, setItem } from '../../lib/storage';

export const VOLUME_KEY = 'filesgg.volume';
export const MUTED_KEY = 'filesgg.muted';

export interface VolumePrefs {
  volume: number;
  muted: boolean;
}

export const DEFAULT_PREFS: VolumePrefs = { volume: 1, muted: false };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function loadVolumePrefs(): VolumePrefs {
  const rawVolume = getItem(VOLUME_KEY);
  const parsed = rawVolume === null || rawVolume.trim() === '' ? Number.NaN : Number(rawVolume);
  return {
    volume: Number.isFinite(parsed) ? clamp01(parsed) : DEFAULT_PREFS.volume,
    muted: getItem(MUTED_KEY) === 'true',
  };
}

export function saveVolumePrefs({ volume, muted }: VolumePrefs): void {
  setItem(VOLUME_KEY, String(Math.round(clamp01(volume) * 100) / 100));
  setItem(MUTED_KEY, String(muted));
}
