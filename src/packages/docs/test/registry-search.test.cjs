const assert = require("node:assert/strict");
const test = require("node:test");
const docs = require("../dist");
const { createDocsRegistry } = require("../dist/registry-core");

function entry({
  actions,
  audiences = ["teams"],
  body = "",
  category = "Test",
  id,
  requiredFeatures,
  searchKeywords,
  siteProfiles,
  slug = id,
  summary = "",
  title,
  visibility,
}) {
  return {
    actions,
    audiences,
    body,
    category,
    id,
    lastReviewed: "2026-09-18",
    requiredFeatures,
    searchKeywords,
    siteProfiles,
    slug,
    status: "ready",
    summary,
    title,
    visibility,
  };
}

function resultIdentity(results) {
  return results.map(({ id, score }) => ({ id, score }));
}

for (const access of [{}, { includeAdmin: true }]) {
  test(`real registry preserves case-independent phrase ranking: ${JSON.stringify(access)}`, () => {
    const expected = resultIdentity(
      docs.searchDocsEntries("use markdown", 12, access),
    );
    assert.ok(expected.some(({ id }) => id === "files.markdown"));
    for (const query of ["Use Markdown", "USE MARKDOWN", "  uSe MaRkDoWn  "]) {
      assert.deepEqual(
        resultIdentity(docs.searchDocsEntries(query, 12, access)),
        expected,
        query,
      );
    }
  });
}

test("title and summary phrase bonuses use the normalized query", () => {
  const registry = createDocsRegistry([
    entry({
      id: "title-exact",
      summary: "Notes",
      title: "Use Markdown",
    }),
    entry({
      id: "title-terms",
      summary: "Notes",
      title: "Use structured Markdown",
    }),
    entry({
      id: "summary-exact",
      summary: "Use Markdown safely",
      title: "Alpha",
    }),
    entry({
      id: "summary-terms",
      summary: "Use structured Markdown safely",
      title: "Beta",
    }),
  ]);

  const scores = Object.fromEntries(
    registry
      .searchDocsEntries("USE MARKDOWN", 10)
      .map(({ id, score }) => [id, score]),
  );
  assert.equal(scores["title-exact"], 24);
  assert.equal(scores["title-terms"], 16);
  assert.equal(scores["summary-exact"], 12);
  assert.equal(scores["summary-terms"], 8);
});

test("normalization preserves internal phrase whitespace and token matching", () => {
  const registry = createDocsRegistry([
    entry({ id: "markdown", title: "Use Markdown" }),
  ]);
  assert.equal(registry.searchDocsEntries(" use   markdown ")[0].score, 16);
  assert.equal(registry.searchDocsEntries(" use markdown ")[0].score, 24);
});

test("all existing field weights remain unchanged", () => {
  const registry = createDocsRegistry([
    entry({
      actions: [
        {
          description: "needle",
          id: "needle.action",
          label: "Needle",
        },
      ],
      audiences: ["needle"],
      body: "needle",
      category: "needle",
      id: "weights",
      searchKeywords: "needle",
      summary: "needle",
      title: "needle",
    }),
  ]);
  assert.equal(registry.searchDocsEntries("NEEDLE")[0].score, 33);
});

test("empty queries retain input order, zero scores, and the requested limit", () => {
  const registry = createDocsRegistry([
    entry({ id: "z", title: "Zulu" }),
    entry({ id: "a", title: "Alpha" }),
  ]);
  assert.deepEqual(resultIdentity(registry.searchDocsEntries("   ", 1)), [
    { id: "z", score: 0 },
  ]);
});

test("equal scores retain title ordering, limits, and unmodified source entries", () => {
  const alpha = entry({ id: "a", title: "Alpha needle" });
  const zulu = entry({ id: "z", title: "Zulu needle" });
  const registry = createDocsRegistry([zulu, alpha]);
  const results = registry.searchDocsEntries("needle", 1);
  assert.deepEqual(resultIdentity(results), [{ id: "a", score: 16 }]);
  assert.equal(Object.hasOwn(alpha, "score"), false);
  assert.equal(Object.hasOwn(zulu, "score"), false);
});

function assertCasePreservesVisibility(name, entries, access, expectedIds) {
  test(`case normalization preserves ${name} visibility`, () => {
    const registry = createDocsRegistry(entries);
    const lower = resultIdentity(
      registry.searchDocsEntries("use markdown", 20, access),
    );
    const upper = resultIdentity(
      registry.searchDocsEntries("USE MARKDOWN", 20, access),
    );
    assert.deepEqual(upper, lower);
    assert.deepEqual(lower.map(({ id }) => id).sort(), [...expectedIds].sort());
  });
}

const publicEntry = entry({ id: "public", title: "Use Markdown" });
const signedInEntry = entry({
  id: "signed-in",
  title: "Use Markdown",
  visibility: "signed-in",
});
const adminEntry = entry({
  id: "admin",
  title: "Use Markdown",
  visibility: "admin",
});

assertCasePreservesVisibility(
  "public",
  [publicEntry, signedInEntry, adminEntry],
  {},
  ["public"],
);
assertCasePreservesVisibility(
  "signed in",
  [publicEntry, signedInEntry, adminEntry],
  { includeSignedIn: true },
  ["public", "signed-in"],
);
assertCasePreservesVisibility(
  "admin",
  [publicEntry, signedInEntry, adminEntry],
  { includeAdmin: true },
  ["public", "signed-in", "admin"],
);
assertCasePreservesVisibility(
  "feature",
  [
    publicEntry,
    entry({
      id: "compute",
      requiredFeatures: ["compute-vms"],
      title: "Use Markdown",
    }),
  ],
  { features: ["compute-vms"] },
  ["public", "compute"],
);
assertCasePreservesVisibility(
  "site profile",
  [
    publicEntry,
    entry({
      id: "profile",
      siteProfiles: ["cocalc-ai"],
      title: "Use Markdown",
    }),
  ],
  { siteProfile: "cocalc-ai" },
  ["public", "profile"],
);
assertCasePreservesVisibility(
  "Plus product",
  [
    entry({ id: "files.markdown", title: "Use Markdown" }),
    entry({ id: "admin.site-settings", title: "Use Markdown" }),
  ],
  { product: "plus" },
  ["files.markdown"],
);
assertCasePreservesVisibility(
  "CoCalc product",
  [
    entry({ id: "files.markdown", title: "Use Markdown" }),
    entry({ id: "admin.site-settings", title: "Use Markdown" }),
  ],
  { product: "cocalc" },
  ["files.markdown", "admin.site-settings"],
);
