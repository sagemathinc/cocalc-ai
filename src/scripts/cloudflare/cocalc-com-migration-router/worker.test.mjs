/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "./worker.mjs";

async function request(path, method = "GET") {
  return await handleRequest(
    new Request(`https://cocalc.com${path}`, { method }),
  );
}

test("unclassified paths use the legacy share resolver", async () => {
  const response = await request(
    "/georeg/matrix-certificates/notebook?viewer=published",
  );
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://cocalc.ai/legacy/georeg/matrix-certificates/notebook?viewer=published",
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-cocalc-migration-policy"), "temporary");
});

test("encoded paths are preserved", async () => {
  const response = await request("/some%20share/%E2%88%9E?a=%2Fvalue");
  assert.equal(
    response.headers.get("location"),
    "https://cocalc.ai/legacy/some%20share/%E2%88%9E?a=%2Fvalue",
  );
});

test("an existing legacy prefix is not duplicated", async () => {
  const response = await request("/legacy/georeg/matrix-certificates/notebook");
  assert.equal(
    response.headers.get("location"),
    "https://cocalc.ai/legacy/georeg/matrix-certificates/notebook",
  );
});

test("verified permanent paths retain direct permanent redirects", async () => {
  const response = await request("/features/terminal/?source=old-site");
  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://cocalc.ai/features/terminal?source=old-site",
  );
  assert.equal(response.headers.get("x-cocalc-migration-policy"), "permanent");
});

test("Cambridge paths retain their dedicated mapping", async () => {
  const response = await request("/cambridge/example/notebook");
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    "https://cocalc.ai/share/Cambridge/example/notebook",
  );
});

test("removed roots remain gone", async () => {
  const response = await request("/github/example");
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("x-cocalc-migration-policy"), "removed");
  assert.match(await response.text(), /Content no longer available/);

  const head = await request("/github/example", "HEAD");
  assert.equal(await head.text(), "");
});
