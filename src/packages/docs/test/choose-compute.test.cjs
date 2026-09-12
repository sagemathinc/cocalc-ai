const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getDocsChapter,
  getDocsEntry,
  listDocsEntries,
  searchDocsEntries,
} = require("../dist");
const { verifyDocsStatic } = require("../dist/verification");

const access = { siteProfile: "cocalc-ai", features: ["compute-vms"] };
const signedInAccess = { ...access, includeSignedIn: true };

test("compute choice is public, searchable, and starts the host reading path", () => {
  const entry = getDocsEntry("hosts/choose-compute");
  assert.ok(entry);
  assert.equal(getDocsEntry(entry.id)?.slug, entry.slug);
  assert.equal(getDocsChapter("Project hosts", access).startEntryId, entry.id);
  const hosts = listDocsEntries(access).filter(
    (item) => item.category === "Project hosts",
  );
  assert.deepEqual(
    hosts.slice(0, 3).map((item) => item.id),
    ["hosts.choose-compute", "hosts.project-hosts", "hosts.access-and-ram"],
  );
  for (const query of ["research compute", "GPU capacity", "more RAM"]) {
    assert.ok(
      searchDocsEntries(query, 5, access).some((item) => item.id === entry.id),
      query,
    );
  }
  assert.ok(
    getDocsEntry("hosts/project-hosts", access).body.includes(
      "/docs/hosts/choose-compute",
    ),
  );
});

test("compute choice resolves all three setup routes and its supporting links", () => {
  const entry = getDocsEntry("hosts/choose-compute", access);
  const links = new Set(
    Array.from(
      entry.body.matchAll(/\]\(\/docs\/([^\s)#]+)(?:#[^)]*)?\)/g),
      (match) => match[1],
    ),
  );
  for (const slug of ["hosts/project-hosts", "jupyter/remote-kernels"]) {
    assert.ok(links.has(slug), slug);
    assert.ok(getDocsEntry(slug, access), slug);
  }
  for (const slug of links) {
    assert.ok(getDocsEntry(slug, signedInAccess), slug);
  }
  assert.doesNotMatch(entry.body, /^#{1,6} \d/m);
  const report = verifyDocsStatic();
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("compute choice remains useful without linking to unavailable local VM docs", () => {
  for (const features of [[], ["compute-vms"]]) {
    const entry = getDocsEntry("hosts/choose-compute", { features });
    assert.ok(entry);
    assert.match(entry.body, /Managed VMs are optional/);
    assert.match(
      entry.body,
      /https:\/\/cocalc.ai\/docs\/projects\/virtual-machines/,
    );
    assert.doesNotMatch(entry.body, /\]\(\/docs\/projects\/virtual-machines\)/);
  }
});
