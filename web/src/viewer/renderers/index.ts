/**
 * Media renderers, keyed by `kind` (Appendix A).
 *
 * Heavy renderers are `lazy()` chunks, so they load only for files that need them
 * and never grow the base viewer bundle (FileCard and the album wrap them in
 * Suspense). Any kind without an entry falls back to the generic download card.
 */

import { lazy } from 'react';

import type { FileData, FileKind } from '../types';
import { GenericRenderer } from './GenericRenderer';
import { ImageRenderer } from './ImageRenderer';
import type { Renderer } from './types';

export const renderers: Partial<Record<FileKind, Renderer>> = {
  image: ImageRenderer,
  pdf: lazy(() => import('../pdf/PdfRenderer')),
  // The custom player (media/), shared by both through a common chunk.
  video: lazy(() => import('../media/VideoRenderer')),
  audio: lazy(() => import('../media/AudioRenderer')),
  // Shiki read-only viewer; Shiki itself and each grammar are further lazy chunks.
  text: lazy(() => import('../text/TextRenderer')),
};

export function getRenderer(kind: FileKind): Renderer {
  return renderers[kind] ?? GenericRenderer;
}

/**
 * The renderer for a file: its kind's, except a document with a preview PDF
 * (milestone-5 §9.2, `assets.document`), which the PDF renderer shows.
 */
export function rendererFor(file: Pick<FileData, 'kind' | 'assets'>): Renderer {
  return file.assets?.document ? (renderers.pdf ?? GenericRenderer) : getRenderer(file.kind);
}

export type { Renderer, RenderContext, RendererProps } from './types';
