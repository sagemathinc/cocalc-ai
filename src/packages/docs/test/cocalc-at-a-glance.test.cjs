const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getDocsEntry } = require("../dist");
const essential = require("../dist/essential");

const SLUG = "documentation/cocalc-at-a-glance";
const COCALC_AI = { siteProfile: "cocalc-ai" };

test("CoCalc at a glance is shown only for the cocalc.ai site profile", () => {
  const entry = getDocsEntry(SLUG, COCALC_AI);
  assert.equal(entry?.id, "docs.cocalc-at-a-glance");
  assert.equal(essential.getDocsEntry(SLUG, COCALC_AI)?.id, entry.id);
  assert.equal(getDocsEntry(SLUG), undefined);
  assert.equal(getDocsEntry(SLUG, { product: "plus" }), undefined);
});

test("CoCalc at a glance links to docs pages that resolve, by their titles", () => {
  const { body } = getDocsEntry(SLUG, COCALC_AI);
  const links = [...body.matchAll(/\[([^\]]+)\]\(\/docs\/([^)\s#]+)\)/g)];
  assert.ok(links.length >= 9, `only ${links.length} docs links`);
  for (const [, label, slug] of links) {
    const target = getDocsEntry(slug, COCALC_AI);
    assert.ok(target, `/docs/${slug} does not resolve on cocalc.ai`);
    assert.equal(
      label,
      target.title,
      `/docs/${slug} is linked by another name`,
    );
  }
});
