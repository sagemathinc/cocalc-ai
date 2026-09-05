/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Render a single PDF page using canvas.
*/

import type { PDFPageProxy, PDFPageViewport } from "pdfjs-dist/webpack.mjs";
import { useCallback, useEffect, useRef } from "react";
import { useDebouncedCallback } from "use-debounce";

import AnnotationLayer, { SyncHighlight } from "./pdfjs-annotation";
import TextLayer from "./pdfjs-text";

interface Props {
  page: PDFPageProxy;
  scale: number;
  clickAnnotation: Function;
  syncHighlight?: SyncHighlight;
  invertColors?: boolean;
}

export default function CanvasPage({
  page,
  scale,
  clickAnnotation,
  syncHighlight,
  invertColors = false,
}: Props) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastScaleRef = useRef<number>(scale);
  const lastRenderScaleRef = useRef<number>(scale);

  const viewport: PDFPageViewport = page.getViewport({
    scale: scale * window.devicePixelRatio,
  });
  const height = `${viewport.height / window.devicePixelRatio}px`;

  // Document colors remain original unless explicitly changed for this view.
  const getCssFilter = useCallback(
    () => (invertColors ? "invert(1) hue-rotate(180deg)" : ""),
    [invertColors],
  );

  const scalePage = useCallback(
    async (scale) => {
      if (lastScaleRef.current == scale) return;
      const div = divRef.current;
      const canvas = canvasRef.current;
      if (div == null || canvas == null) return;
      lastScaleRef.current = scale;
      const viewport: PDFPageViewport = page.getViewport({
        scale: scale * window.devicePixelRatio,
      });
      canvas.style.width = `${viewport.width / window.devicePixelRatio}px`;
      canvas.style.height = `${viewport.height / window.devicePixelRatio}px`;
      canvas.style.filter = getCssFilter();
    },
    [getCssFilter],
  );

  const renderPage = useCallback(
    async (page, scale) => {
      if (divRef.current == null) return;
      lastScaleRef.current = lastRenderScaleRef.current = scale;
      const div = divRef.current;
      const viewport: PDFPageViewport = page.getViewport({
        scale: scale * window.devicePixelRatio,
      });
      const canvas: HTMLCanvasElement = document.createElement("canvas");
      canvasRef.current = canvas;
      const ctx = canvas.getContext("2d");
      if (ctx == null) {
        console.error(
          "pdf.js -- unable to get a 2d canvas, so not rendering page",
        );
        return;
      }
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / window.devicePixelRatio}px`;
      canvas.style.height = `${viewport.height / window.devicePixelRatio}px`;
      canvas.style.filter = getCssFilter();
      div.replaceChildren(canvas);
      try {
        await page.render({
          canvasContext: ctx,
          viewport: viewport,
        }).promise;
      } catch (err) {
        console.error(`pdf.js -- Error rendering canvas page: ${err}`);
        return;
      }
    },
    [getCssFilter],
  );

  const debouncedRender = useDebouncedCallback(renderPage, 500);

  useEffect(() => {
    renderPage(page, scale);
  }, [page]);

  useEffect(() => {
    scalePage(scale);
    if (lastRenderScaleRef.current < scale) {
      // upscaling, so may need to render.
      debouncedRender(page, scale);
    } else {
      debouncedRender.cancel();
    }
  }, [scale]);

  // Update presentation without rerendering the PDF or changing its contents.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.filter = getCssFilter();
    }
  }, [getCssFilter]);

  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        height,
      }}
    >
      <AnnotationLayer
        page={page}
        scale={scale}
        clickAnnotation={clickAnnotation}
        syncHighlight={syncHighlight}
      />
      <div ref={divRef} />
      <TextLayer page={page} scale={scale} viewport={viewport} />
    </div>
  );
}
