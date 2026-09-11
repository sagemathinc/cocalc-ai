const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getDocsEntry, searchDocsEntries } = require("../dist");
const { verifyDocsStatic } = require("../dist/verification");
const access = { siteProfile: "cocalc-ai" };

test("remote kernels guide is registered, linked, and searchable", () => {
  const entry = getDocsEntry("jupyter/remote-kernels", access);
  assert.ok(entry);
  assert.ok(entry.body.includes("**CoCalc AI**"));
  assert.ok(entry.noActionReason);
  assert.ok(
    getDocsEntry("jupyter/use-jupyter").body.includes(
      "/docs/jupyter/remote-kernels",
    ),
  );
  for (const query of ["remote kernel", "SageJS", "GPU", "file sync"]) {
    assert.ok(
      searchDocsEntries(query, 8, access).some(
        (result) => result.id === entry.id,
      ),
      query,
    );
  }
  assert.equal(verifyDocsStatic().ok, true);
  for (const match of entry.body.matchAll(
    /\]\(\/docs\/([^\s)#]+)(?:#[^)]*)?\)/g,
  )) {
    assert.ok(getDocsEntry(match[1], access), match[1]);
  }
});

test("remote kernels guide distinguishes storage, execution, and billing", () => {
  const { body } = getDocsEntry("jupyter/remote-kernels", access);
  for (const phrase of [
    "no automatic file sync",
    "from the CoCalc project",
    "do not back up files",
    "does not provision a GPU",
    "any language",
    "same live notebook tools",
    "does not\nstop the VM",
  ]) {
    assert.ok(body.includes(phrase), phrase);
  }
});
