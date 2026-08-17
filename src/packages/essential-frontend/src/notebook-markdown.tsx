/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Markdown } from "./markdown";

export default function NotebookMarkdown({ source }: { source: string }) {
  return <Markdown source={source} />;
}
