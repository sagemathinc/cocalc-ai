/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Convert an *HTML* file (raw url or string content) to printable form.

TODO: refactor with markdown print (?).
*/

import { path_split } from "@cocalc/util/misc";
import { HTML } from "@cocalc/frontend/components";
import { renderToStaticMarkup } from "react-dom/server";
import { React, Redux, redux } from "@cocalc/frontend/app-framework";
import { BASE_URL } from "@cocalc/frontend/misc";
import { resource_links_string } from "@cocalc/frontend/misc/resource-links";
import { writePassiveDocument } from "@cocalc/frontend/misc/print-document";

let BLOCKED: boolean | undefined = undefined;

export function popup(
  url: string,
  width: number = 800,
  height: number = 640,
): any {
  const w: any = window.open(
    url,
    "_blank",
    `menubar=yes,toolbar=no,resizable=yes,scrollbars=yes,height=${height},width=${width}`,
  );
  if (!w || w.closed === undefined) {
    if (BLOCKED || BLOCKED === undefined) {
      // no history, or known blocked
      BLOCKED = true;
      throw Error("Popup blocked.  Please unblock popups for this site.");
    } else {
      // definitely doesn't block -- this happens when window already opened and printing.
      throw Error(
        "If you have a window already opened printing a document, close it first.",
      );
    }
  }
  BLOCKED = false;
  return w;
}

interface PrintOptions {
  value?: string; // string with html; will get processed (e.g., links, math typesetting, etc.) -- meant to go in body
  html?: string; // rendered html string (no post processing done) -- meant to go in body
  src?: string; // if given, just loads that url (default: ''); this is typically a raw URL into a project.
  path?: string; // must be given if src is empty, so can put it in the HTML title and relative links work.
  project_id?: string; // must be given if src is empty
}

// Raises an exception if there is an error.

export function print_html(opts: PrintOptions): void {
  if (!opts.src) opts.src = "";
  const w: any = popup(opts.src);
  if (opts.src == "") {
    if (!opts.project_id || !opts.path) {
      throw Error(
        "BUG project_id and path must be specified if src not given.",
      );
    }
    write_content(w, opts);
  }
  print_window(w);
}

export function print_window(w): void {
  if (w.window.print === null) {
    return;
  }
  // Wait until the render is done, then display print dialog.
  w.window.onload = () => {
    w.window.print();
  };
}

function write_content(w, opts: PrintOptions): void {
  if (!opts.path) throw Error("write_content -- path must be defined");
  const split = path_split(opts.path);

  let html: string;
  if (opts.html == null) {
    const props = {
      value: opts.value,
      project_id: opts.project_id,
      file_path: split.head,
    };

    const C = React.createElement(
      Redux,
      { redux } as any,
      React.createElement(HTML, props),
    );
    html = renderToStaticMarkup(C);
  } else {
    html = opts.html;
  }
  // The html is rendered content from documents other people can edit.
  writePassiveDocument(w, {
    title: path_split(opts.path).tail,
    head: `<meta name="google" content="notranslate"/>${resource_links_string(BASE_URL)}`,
    bodyStyle: "margin:7%",
    body: html,
  });
}
