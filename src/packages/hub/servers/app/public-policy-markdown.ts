/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response, Router } from "express";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import getCustomize from "@cocalc/database/settings/customize";
import { getLogger } from "@cocalc/hub/logger";
import {
  POLICY_MARKDOWN_ASSET,
  type PolicyMarkdownDocument,
} from "@cocalc/util/public-policy-markdown";
import {
  getExternalPoliciesUrl,
  getPublicPolicyPages,
} from "@cocalc/util/public-site-metadata";
import { resolveStaticPath } from "./public-static-path";

const logger = getLogger("hub:servers:public-policy-markdown");

export async function getPolicyMarkdownDocuments(): Promise<
  PolicyMarkdownDocument[]
> {
  return JSON.parse(
    await readFile(join(resolveStaticPath(), POLICY_MARKDOWN_ASSET), "utf8"),
  );
}

export function builtinPolicyMarkdownEnabled(customize: {
  policy_pages?: string;
  termsOfServiceURL?: string;
}): boolean {
  return (
    getPublicPolicyPages(customize) === "sagemathinc" &&
    !getExternalPoliciesUrl({
      terms_of_service_url: customize.termsOfServiceURL,
    })
  );
}

export function servePolicyMarkdown(req: Request, res: Response): void {
  res.vary("Host");
  // Configuration can change without rebuilding the frontend assets.
  res.setHeader("Cache-Control", "no-cache");
  void (async () => {
    const customize = await getCustomize();
    if (!builtinPolicyMarkdownEnabled(customize)) {
      res.sendStatus(404);
      return;
    }
    const documents = await getPolicyMarkdownDocuments();
    const policy = documents.find(({ slug }) => slug === req.params.slug);
    if (!policy) {
      res.sendStatus(404);
      return;
    }
    res.type("text/markdown").send(policy.markdown);
  })().catch((err) => {
    logger.warn("policy Markdown endpoint failed", { err: `${err}` });
    res
      .status(503)
      .type("text/plain")
      .send("Policy text temporarily unavailable");
  });
}

export function initPublicPolicyMarkdown(router: Router): void {
  router.get("/policies/:slug.md", servePolicyMarkdown);
}
