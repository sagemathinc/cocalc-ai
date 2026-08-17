/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { lazy, Suspense, useEffect, useState } from "react";
import type { NotebookBlobResolver } from "./notebook-blobs";
import { isNotebookBlobReference } from "./notebook-blobs";
import HighlightedCode from "./highlighted-code";
import {
  languageForCode,
  languageForName,
  type UltraliteLanguage,
} from "./code-language";

const NotebookMarkdown = lazy(
  () =>
    new Promise((resolve, reject) => {
      if (process.env.COCALC_TEST_MODE) {
        resolve(require("./notebook-markdown"));
        return;
      }
      require.ensure(
        [],
        () => resolve(require("./notebook-markdown")),
        reject,
        "ultralite-notebook-markdown",
      );
    }),
);

export interface NotebookOutput {
  output_type?: string;
  name?: string;
  text?: string | string[];
  traceback?: string[];
  data?: Record<string, string | string[]>;
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
}

export interface NotebookCell {
  id?: string;
  cell_type?: string;
  execution_count?: number | null;
  source?: string | string[];
  outputs?: NotebookOutput[];
  metadata?: Record<string, unknown>;
  attachments?: Record<string, unknown>;
}

export interface NotebookDocument {
  cells: NotebookCell[];
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: Record<string, any>;
}

export function sourceText(source?: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source || "";
}

export function parseNotebook(contents: string): NotebookDocument {
  const value = JSON.parse(contents) as Partial<NotebookDocument>;
  if (!Array.isArray(value.cells)) {
    throw new Error("This file is not a valid Jupyter notebook.");
  }
  return { ...value, cells: value.cells };
}

export function notebookCodeLanguage(
  notebook: NotebookDocument,
): UltraliteLanguage | undefined {
  const metadata = notebook.metadata ?? {};
  return languageForName(
    `${metadata.language_info?.name ?? metadata.kernelspec?.language ?? ""}`,
  );
}

export function NotebookOutputView({
  blobResolver,
  output,
  index,
}: {
  blobResolver?: NotebookBlobResolver;
  output: NotebookOutput;
  index: number;
}) {
  const text =
    sourceText(output.text) || sourceText(output.data?.["text/plain"]);
  const traceback =
    sourceText(output.traceback) ||
    [output.ename, output.evalue].filter(Boolean).join(": ");
  const png = sourceText(output.data?.["image/png"]);
  const jpeg = sourceText(output.data?.["image/jpeg"]);
  const image = png || jpeg;
  const mime = png ? "image/png" : "image/jpeg";
  if (image) {
    return (
      <NotebookImage
        blobResolver={blobResolver}
        data={image}
        index={index}
        mime={mime}
      />
    );
  }
  if (traceback || text) {
    return <pre className="ul-output">{traceback || text}</pre>;
  }
  if (output.data?.["text/html"]) {
    return (
      <p className="ul-notice">
        Interactive HTML output is omitted in the safe read-only viewer. Open
        full CoCalc to render it.
      </p>
    );
  }
  return null;
}

function NotebookImage({
  blobResolver,
  data,
  index,
  mime,
}: {
  blobResolver?: NotebookBlobResolver;
  data: string;
  index: number;
  mime: "image/jpeg" | "image/png";
}) {
  const normalized = data.replace(/\s/g, "");
  const reference = isNotebookBlobReference(normalized);
  const [source, setSource] = useState(
    reference ? undefined : `data:${mime};base64,${normalized}`,
  );
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!reference || !blobResolver) return;
    let active = true;
    let objectUrl: string | undefined;
    setError(undefined);
    setSource(undefined);
    void blobResolver
      .resolve(normalized)
      .then((bytes) => {
        if (!active) return;
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        objectUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));
        setSource(objectUrl);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : `${err}`);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [blobResolver, mime, normalized, reference]);

  if (error) {
    return <p className="ul-notice">Image output unavailable: {error}</p>;
  }
  if (!source) {
    return (
      <p className="ul-muted ul-output-loading">Loading image output...</p>
    );
  }
  return (
    <img
      alt={`Notebook output ${index + 1}`}
      className="ul-output-image"
      loading="lazy"
      src={source}
    />
  );
}

export function NotebookMarkdownCell({ source }: { source: string }) {
  return (
    <div className="ul-markdown ul-markdown-cell">
      <Suspense fallback={<p className="ul-muted">Rendering Markdown...</p>}>
        <NotebookMarkdown source={source} />
      </Suspense>
    </div>
  );
}

export default function NotebookView({
  blobResolver,
  notebook,
}: {
  blobResolver?: NotebookBlobResolver;
  notebook: NotebookDocument;
}) {
  const notebookLanguage = notebookCodeLanguage(notebook);
  return (
    <div className="ul-notebook">
      {notebook.cells.map((cell, index) => {
        const source = sourceText(cell.source);
        if (cell.cell_type === "markdown") {
          return (
            <section className="ul-cell" key={index}>
              <div className="ul-cell-label">
                {cell.cell_type || "text"} cell {index + 1}
              </div>
              <NotebookMarkdownCell source={source} />
            </section>
          );
        }
        if (cell.cell_type === "raw") {
          return (
            <section className="ul-cell" key={index}>
              <div className="ul-cell-label">raw cell {index + 1}</div>
              <pre className="ul-raw-cell">{source}</pre>
            </section>
          );
        }
        return (
          <section className="ul-cell" key={index}>
            <div className="ul-cell-label">
              Code cell {index + 1}
              {cell.execution_count != null
                ? ` - execution ${cell.execution_count}`
                : ""}
            </div>
            <HighlightedCode
              className="ul-code"
              contents={source}
              language={notebookLanguage ?? languageForCode("", source)}
            />
            {cell.outputs?.map((output, outputIndex) => (
              <NotebookOutputView
                blobResolver={blobResolver}
                index={outputIndex}
                key={outputIndex}
                output={output}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}
