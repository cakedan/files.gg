import type { ComponentType } from 'react';

import type { FileData } from '../types';

/**
 * Where a renderer is shown:
 * - `card`: the single-file viewer page (it may own page-wide keys and the URL hash);
 * - `list`: an album's list layout, full card width;
 * - `lightbox`: the album carousel, which owns ←/→ and Esc.
 */
export type RenderContext = 'card' | 'list' | 'lightbox';

export interface RendererProps {
  file: FileData;
  context?: RenderContext | undefined;
  /** Set by albums: clicking the media opens the album lightbox instead of the renderer's own. */
  onOpen?: (() => void) | undefined;
}

export type Renderer = ComponentType<RendererProps>;
