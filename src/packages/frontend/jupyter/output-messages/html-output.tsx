/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
HTML output of a notebook cell.  It never renders unsanitized in the app page,
whether or not the notebook is trusted: output that sanitizing would visibly
change (styles, scripts, maps, plots, ...) renders in an opaque frame, which
follows the app's theme; the rest renders inline, sanitized.
*/

import { useMemo, useRef } from "react";
import HTML from "@cocalc/frontend/components/html-ssr";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { shouldIsolateHtmlOutput } from "@cocalc/jupyter/util/iframe";
import AutosizedIframe from "./autosized-iframe";
import { useFrameTheme, withFrameTheme } from "./frame-theme";
import { sanitizedHtmlIsFaithful } from "./html-fidelity";

export function htmlOutputNeedsFrame(html: string): boolean {
  return shouldIsolateHtmlOutput(html) || !sanitizedHtmlIsFaithful(html);
}

export function FramedHtml({ html }: { html: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const { post } = useFrameTheme(frameRef);
  const srcDoc = useMemo(() => withFrameTheme(html), [html]);
  return (
    <AutosizedIframe
      srcDoc={srcDoc}
      profile="opaque-legacy"
      title="Jupyter HTML output"
      onLoad={(iframe) => {
        frameRef.current = iframe;
        post(iframe);
      }}
    />
  );
}

export function SanitizedHtml({ html }: { html: string }) {
  const fileContext = useFileContext();
  return (
    <FileContext.Provider value={{ ...fileContext, noSanitize: false }}>
      <HTML value={html} />
    </FileContext.Provider>
  );
}

export default function HtmlOutput({ value }: { value: unknown }) {
  const html = `${value ?? ""}`;
  const framed = useMemo(() => htmlOutputNeedsFrame(html), [html]);
  return framed ? <FramedHtml html={html} /> : <SanitizedHtml html={html} />;
}
