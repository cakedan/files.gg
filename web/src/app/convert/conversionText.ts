/** The Convert page's words for a conversion (milestone-5 §8, §12, §13.1). Pure. */

import { conversionMessage } from '../../lib/conversionErrors';
import type { Conversion, ConversionStage } from '../../lib/conversions';
import { formatBytes } from '../../lib/format';
import { pluralize } from '../files/fileLabels';

export const STAGE_LABELS: Record<ConversionStage, string> = {
  downloading: 'Getting the file ready',
  converting: 'Converting',
  storing: 'Saving the result',
};

/** "Waiting in line: 3 ahead" (§8). */
export function queueLine(position: number): string {
  return position > 0 ? `Waiting in line: ${position.toLocaleString('en')} ahead` : 'Waiting in line: you’re next';
}

/** The message for a finished conversion that didn't succeed (§12). */
export function outcomeMessage(conversion: Pick<Conversion, 'status' | 'error'>, anonymous: boolean): string {
  const error = conversion.error;
  if (conversion.status === 'cancelled' && !error) return 'Cancelled.';
  if (!error) return 'The conversion failed.';
  return conversionMessage(error.code, error.metadata ?? {}, { anonymous, apiMessage: error.message }) ?? (error.message || 'The conversion failed.');
}

/** "1.2 MB → 300 KB (−75%)" (§13.1 step 5). */
export function sizeChange(before: number | null, after: number | null): string | null {
  if (!before || !after) return after ? formatBytes(after) : null;
  const percent = Math.round(((after - before) / before) * 100);
  const sign = percent > 0 ? '+' : percent < 0 ? '−' : '±';
  return `${formatBytes(before)} → ${formatBytes(after)} (${sign}${Math.abs(percent)}%)`;
}

/** A row's source: the file's name, the album's title, or "3 images". */
export const sourceName = (conversion: Pick<Conversion, 'source'>): string =>
  conversion.source.file?.filename ??
  (conversion.source.album && 'title' in conversion.source.album ? conversion.source.album.title || 'Untitled album' : null) ??
  pluralize(conversion.source.count, 'image');

/** What re-running a history row sends (§10.3): the same source, by vanity. */
export function rerunSource(conversion: Pick<Conversion, 'source'>): { source: string } | { album: string } | null {
  if (conversion.source.file?.vanity) return { source: conversion.source.file.vanity };
  const album = conversion.source.album;
  if (album && 'vanity' in album) return { album: album.vanity };
  return null;
}
