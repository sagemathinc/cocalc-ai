/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Markdown } from "./markdown";

export default function MarkdownView({ source }: { source: string }) {
  return (
    <article className="ul-markdown-document">
      <Markdown source={source} />
    </article>
  );
}
