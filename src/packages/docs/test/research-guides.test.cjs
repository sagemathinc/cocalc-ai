const assert = require("node:assert/strict");
const test = require("node:test");
const { getDocsEntry, listDocsChapters, listDocsEntries } = require("../dist");
const { verifyDocsStatic } = require("../dist/verification");

test("research chapter exposes all workflows and resolves their internal links", () => {
  const entries = listDocsEntries().filter(
    (e) => e.category === "Research workflows",
  );
  assert.equal(entries.length, 9);
  assert.ok(
    listDocsChapters().some(
      (c) => c.startEntryId === "research.reproduce-analysis",
    ),
  );
  for (const entry of entries) {
    assert.equal(getDocsEntry(entry.slug)?.id, entry.id);
    assert.doesNotMatch(entry.body, /^#{1,6} \d/m, entry.id);
    for (const match of entry.body.matchAll(
      /\]\(\/docs\/([^\s)#]+)(?:#[^)]*)?\)/g,
    )) {
      assert.ok(getDocsEntry(match[1]), `${entry.id}: ${match[1]}`);
    }
  }
  const report = verifyDocsStatic();
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("external documentation URLs do not hide broken site-relative links", () => {
  const entry = getDocsEntry("research.reproduce-analysis");
  const original = entry.body;
  try {
    entry.body =
      "[External](https://example.com/docs/external-only)\n" +
      "[Query](https://example.com?next=/docs/external-query)\n" +
      "[Reference][guide]\n\n[guide]:/docs/missing-reference\n\n" +
      "[Adjacent](https://example.com/docs/other)[Local](/docs/missing-adjacent)\n" +
      "[Missing](/docs/missing-research-example)\n" +
      "[Existing](/docs/projects/create-project)";
    const links = verifyDocsStatic().issues.filter(
      (issue) =>
        issue.entryId === entry.id && issue.code === "entry-internal-link",
    );
    assert.equal(links.length, 3);
    for (const slug of [
      "missing-reference",
      "missing-adjacent",
      "missing-research-example",
    ]) {
      assert.ok(
        links.some((link) => link.message.includes(slug)),
        slug,
      );
    }
  } finally {
    entry.body = original;
  }
});
