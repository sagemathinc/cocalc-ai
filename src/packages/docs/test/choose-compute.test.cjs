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

test("compute choice links stay usable with VM support on or off", () => {
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
  assert.ok(!links.has("projects/virtual-machines"));
  for (const includeSignedIn of [false, true]) {
    for (const vmEnabled of [false, true]) {
      const currentAccess = {
        includeSignedIn,
        features: vmEnabled ? ["compute-vms"] : [],
      };
      assert.ok(getDocsEntry(entry.slug, currentAccess));
      assert.equal(
        !!getDocsEntry("projects/virtual-machines", currentAccess),
        vmEnabled,
      );
      for (const slug of links) {
        assert.ok(
          getDocsEntry(slug, currentAccess),
          `${slug}: signedIn=${includeSignedIn}, vmEnabled=${vmEnabled}`,
        );
      }
    }
  }
  assert.doesNotMatch(entry.body, /^#{1,6} \d/m);
  const report = verifyDocsStatic();
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("registered chapter links stay available to each reader profile", () => {
  const profiles = [
    ["plus", { product: "plus" }],
    ["ai-public", { siteProfile: "cocalc-ai" }],
    ["ai-public-vms", { siteProfile: "cocalc-ai", features: ["compute-vms"] }],
    ["ai-signed-in", { siteProfile: "cocalc-ai", includeSignedIn: true }],
    [
      "ai-admin",
      {
        siteProfile: "cocalc-ai",
        includeAdmin: true,
        features: ["compute-vms"],
      },
    ],
  ];
  for (const [label, currentAccess] of profiles) {
    for (const entry of listDocsEntries(currentAccess)) {
      for (const match of entry.body.matchAll(/\]\((\/docs\/[^\s)]+)\)/g)) {
        const target = match[1].slice("/docs/".length).split(/[?#]/, 1)[0];
        if (!target) continue;
        assert.ok(
          getDocsEntry(target, currentAccess),
          `${label}: ${entry.id} links to unavailable ${target}`,
        );
      }
    }
  }
});
