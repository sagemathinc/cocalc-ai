/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface PolicyMarkdownDocument {
  slug: string;
  title: string;
  description: string;
  updated: string;
  markdown: string;
}

export const POLICY_MARKDOWN_ASSET = "policy-markdown.json";
