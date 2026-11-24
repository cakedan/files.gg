/**
 * pdf.js setup. Only imported from the lazy PDF chunk, so the viewer entry never
 * pulls in pdf.js.
 *
 * - The worker is its own same-origin asset (CSP `worker-src 'self'`).
 * - CMaps, standard fonts, wasm decoders and ICC profiles are served same-origin
 *   from /assets/pdfjs/<version>/ (see vite.plugins.ts).
 * - Documents load through HTTP range requests (64 KB chunks) with streaming and
 *   auto-fetch off, so page 1 shows before the whole file downloads.
 */

import {
  getDocument,
  GlobalWorkerOptions,
  version,
  type PDFDocumentLoadingTask,
  type PDFPageProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { rotatedSize, type Size } from './pdfState';

export { AnnotationLayer, AnnotationMode, PasswordResponses, TextLayer } from 'pdfjs-dist';
export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
export type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

GlobalWorkerOptions.workerSrc = workerUrl;

export const RANGE_CHUNK_SIZE = 65536;

const assetBase = () => new URL(`/assets/pdfjs/${version}/`, window.location.origin).href;

/** The options every document is opened with. Exported for the tests. */
export function documentOptions(url: string) {
  const base = assetBase();
  return {
    url,
    rangeChunkSize: RANGE_CHUNK_SIZE,
    disableStream: true,
    disableAutoFetch: true,
    withCredentials: false,
    // Safety: pdf.js 5+ has no eval code path left, but keep the flag explicit in
    // case an older build is ever swapped in. PDF JavaScript never runs: the
    // scripting sandbox is never loaded and the annotation layer gets
    // enableScripting: false.
    isEvalSupported: false,
    enableXfa: false,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    disableWorkerRendering: true,
  };
}

export function openDocument(url: string): PDFDocumentLoadingTask {
  return getDocument(documentOptions(url) as Parameters<typeof getDocument>[0]);
}

/** The page's size in points as displayed at rotation 0 (its own /Rotate applied). */
export function pageSize(page: PDFPageProxy): Size {
  const [x0 = 0, y0 = 0, x1 = 612, y1 = 792] = page.view;
  const raw = { width: (x1 - x0) * page.userUnit, height: (y1 - y0) * page.userUnit };
  return rotatedSize(raw, page.rotate);
}

