import { memo, useEffect, useRef, useState } from 'react';

import { applyHighlights } from './highlight';
import {
  AnnotationLayer,
  AnnotationMode,
  pageSize,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
  type TextContent,
} from './pdfjs';
import { PDF_TO_CSS, type PageMatch, type Size } from './pdfState';

/** Canvases above this many pixels render at a lower resolution (iOS caps ~16.7M). */
const MAX_CANVAS_PIXELS = 16_777_216 / 2;

export interface PdfServices {
  doc: PDFDocumentProxy;
  /** pdf.js link-service contract used by the annotation layer. */
  linkService: object;
  /** Cached per page so the text layer and search see identical items. */
  textContent: (page: number) => Promise<TextContent>;
  onPageSize: (page: number, size: Size) => void;
}

interface PdfPageProps {
  services: PdfServices;
  pageNumber: number;
  width: number;
  height: number;
  /** Scale the canvas renders at (debounced while zooming); the box uses the live scale. */
  renderScale: number;
  rotation: number;
  /** Inside the render window: holds a canvas. Outside: released. */
  active: boolean;
  matches: readonly PageMatch[];
  /** Index into `matches` of the selected match, or -1. */
  selected: number;
  onSelectedElement: (element: HTMLElement) => void;
}

interface Layers {
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  task: RenderTask | null;
  textLayer: TextLayer | null;
  textDiv: HTMLDivElement;
  annotationDiv: HTMLDivElement;
}

function releaseCanvas(canvas: HTMLCanvasElement | null | undefined) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

export const PdfPage = memo(function PdfPage({
  services,
  pageNumber,
  width,
  height,
  renderScale,
  rotation,
  active,
  matches,
  selected,
  onSelectedElement,
}: PdfPageProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<Layers | null>(null);
  const touched = useRef(new Set<number>());
  const [textReady, setTextReady] = useState(0);
  const [failed, setFailed] = useState(false);

  // Render (or release) the canvas, text layer and annotation layer.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    if (!active) {
      const layers = layersRef.current;
      if (layers) {
        layers.task?.cancel();
        layers.textLayer?.cancel();
        releaseCanvas(layers.canvas);
        layers.textDiv.remove();
        layers.annotationDiv.remove();
        layers.page.cleanup();
        layersRef.current = null;
        touched.current.clear();
      }
      return;
    }

    let cancelled = false;
    let task: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    (async () => {
      const page = await services.doc.getPage(pageNumber);
      if (cancelled) return;
      services.onPageSize(pageNumber, pageSize(page));

      const viewport = page.getViewport({ scale: renderScale * PDF_TO_CSS, rotation: (rotation + page.rotate) % 360 });
      const dpr = window.devicePixelRatio || 1;
      const pixels = viewport.width * viewport.height * dpr * dpr;
      const outputScale = pixels > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)) : dpr;

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.setAttribute('role', 'presentation');
      const sx = canvas.width / viewport.width;
      const sy = canvas.height / viewport.height;

      task = page.render({
        canvas,
        viewport,
        transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : undefined,
        annotationMode: AnnotationMode.ENABLE,
      });
      try {
        await task.promise;
      } catch (error) {
        releaseCanvas(canvas);
        if ((error as { name?: string })?.name !== 'RenderingCancelledException' && !cancelled) setFailed(true);
        return;
      }
      if (cancelled) {
        releaseCanvas(canvas);
        return;
      }

      // Swap in the new canvas only once it's drawn, so zooming never flashes white.
      const previous = layersRef.current;
      previous?.textLayer?.cancel();
      releaseCanvas(previous?.canvas);
      previous?.textDiv.remove();
      previous?.annotationDiv.remove();
      touched.current.clear();
      slot.style.setProperty('--scale-factor', String(renderScale * PDF_TO_CSS));
      slot.style.setProperty('--user-unit', String(page.userUnit));
      slot.prepend(canvas);

      const textDiv = document.createElement('div');
      textDiv.className = 'textLayer';
      const annotationDiv = document.createElement('div');
      annotationDiv.className = 'annotationLayer';
      slot.append(textDiv, annotationDiv);
      layersRef.current = { page, canvas, task: null, textLayer: null, textDiv, annotationDiv };

      try {
        const content = await services.textContent(pageNumber);
        if (cancelled) return;
        textLayer = new TextLayer({ textContentSource: content, container: textDiv, viewport });
        await textLayer.render();
        if (cancelled) return;
        const end = document.createElement('div');
        end.className = 'endOfContent';
        textDiv.append(end);
        layersRef.current.textLayer = textLayer;
        setTextReady((n) => n + 1);
      } catch {
        // No text layer: the page still shows; it just isn't selectable.
      }

      try {
        const annotations = await page.getAnnotations({ intent: 'display' });
        if (cancelled || annotations.length === 0) return;
        const layer = new AnnotationLayer({
          div: annotationDiv,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          page,
          viewport: viewport.clone({ dontFlip: true }),
          structTreeLayer: null,
          commentManager: null,
          linkService: services.linkService,
          annotationStorage: null,
        });
        await layer.render({
          annotations,
          page,
          viewport: viewport.clone({ dontFlip: true }),
          div: annotationDiv,
          linkService: services.linkService as never,
          renderForms: false,
          enableScripting: false,
          hasJSActions: false,
        });
      } catch {
        // Links are a nicety; the page is already shown.
      }
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
  }, [active, pageNumber, renderScale, rotation, services]);

  // Unmount: release everything.
  useEffect(
    () => () => {
      const layers = layersRef.current;
      if (layers) {
        layers.task?.cancel();
        releaseCanvas(layers.canvas);
        layersRef.current = null;
      }
    },
    [],
  );

  // Search highlights, re-applied whenever matches or the text layer change.
  useEffect(() => {
    const textLayer = layersRef.current?.textLayer;
    if (!textLayer) return;
    const element = applyHighlights(textLayer, matches, selected, touched.current);
    if (element) onSelectedElement(element);
  }, [matches, selected, textReady, onSelectedElement]);

  return (
    <div
      ref={slotRef}
      className="pdf-page"
      data-page-number={pageNumber}
      data-loaded={active ? 'true' : 'false'}
      style={{ width, height }}
      aria-label={`Page ${pageNumber}`}
      role="region"
    >
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
          Couldn't render page {pageNumber}
        </div>
      )}
    </div>
  );
});
