/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Compiler, WebpackPluginInstance } from "@rspack/core";
import { BUILTIN_POLICIES } from "@cocalc/frontend/public/policies/registry";
import { policyMarkdown } from "@cocalc/frontend/public/policies/markdown";
import { POLICY_MARKDOWN_ASSET } from "@cocalc/util/public-policy-markdown";

export default function policyMarkdownPlugin(
  register: (description: string, plugin: WebpackPluginInstance) => void,
) {
  register("Policy Markdown", {
    apply(compiler: Compiler) {
      compiler.hooks.thisCompilation.tap("PolicyMarkdown", (compilation) => {
        compilation.hooks.processAssets.tap("PolicyMarkdown", () => {
          compilation.emitAsset(
            POLICY_MARKDOWN_ASSET,
            new compiler.webpack.sources.RawSource(
              JSON.stringify(
                BUILTIN_POLICIES.map((policy) => ({
                  slug: policy.slug,
                  title: policy.title,
                  description: policy.description,
                  updated: policy.updated,
                  markdown: policyMarkdown(policy),
                })),
              ),
            ),
          );
        });
      });
    },
  });
}
