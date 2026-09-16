const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const docs = require("../dist");
const essential = require("../dist/essential");
const { ADMIN_ENTRIES } = require("../dist/entries/admin");
const { orderDocsEntries } = require("../dist/entries/order");

const essentialAccess = { includeSignedIn: true, siteProfile: "cocalc-ai" };

// This client uses the canonical objects: metadata and complete article bodies
// must remain identical, not just the list of titles.
test("Essential preserves every visible article and its registry order", () => {
  const expected = docs.listDocsEntries(essentialAccess);
  assert.deepEqual(essential.listDocsEntries(essentialAccess), expected);
  for (const entry of expected) {
    assert.strictEqual(
      essential.getDocsEntry(entry.id, essentialAccess),
      entry,
    );
    assert.strictEqual(
      essential.getDocsEntry(`/docs/${entry.slug}/`, essentialAccess),
      entry,
    );
  }
  assert.equal(
    essential.getDocsEntry("unknown-entry", essentialAccess),
    undefined,
  );
  assert.ok(ADMIN_ENTRIES.length > 0);
  for (const entry of ADMIN_ENTRIES) {
    assert.equal(entry.visibility, "admin");
    assert.strictEqual(
      docs.getDocsEntry(entry.id, { includeAdmin: true }),
      entry,
    );
    assert.equal(
      essential.getDocsEntry(entry.id, { includeAdmin: true }),
      undefined,
    );
  }
});

test("Essential retains shared access filtering and search scores", () => {
  const queries = [
    "",
    "   ",
    "kernel",
    "custom Jupyter kernels",
    "Research Compute",
    "GPU capacity",
    "memory",
    "snapshot",
    "input_sha256",
    "read-only",
    "settings.people.collaborators",
    "Open project hosts",
    "remote",
    "no-such-docs-query-7bb25b",
  ];
  for (const includeSignedIn of [false, true]) {
    for (const siteProfile of [undefined, "cocalc-ai"]) {
      for (const product of [undefined, "plus"]) {
        for (const features of [[], ["compute-vms"]]) {
          const access = { includeSignedIn, siteProfile, product, features };
          const expected = docs.listDocsEntries(access);
          assert.deepEqual(essential.listDocsEntries(access), expected);
          for (const query of queries) {
            for (const limit of [0, 3, expected.length]) {
              assert.deepEqual(
                essential.searchDocsEntries(query, limit, access),
                docs.searchDocsEntries(query, limit, access),
                JSON.stringify({ query, limit, access }),
              );
            }
          }
        }
      }
    }
  }
});

test("the full registry still requires all registered entry IDs", () => {
  assert.throws(
    () => orderDocsEntries(docs.DOCS_ENTRIES.slice(1)),
    /Unknown docs entry id/,
  );
  assert.deepEqual(
    orderDocsEntries([...docs.DOCS_ENTRIES].reverse()),
    docs.DOCS_ENTRIES,
  );
});

test("loading Essential does not load administrator entries or content", () => {
  const modules = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `
    require(${JSON.stringify(require.resolve("../dist/essential"))});
    process.stdout.write(JSON.stringify(Object.keys(require.cache)));
  `,
      ],
      { encoding: "utf8" },
    ),
  );
  const normalized = modules.map((name) => name.replaceAll("\\", "/"));
  assert.ok(normalized.some((name) => name.endsWith("/content/hosts.js")));
  assert.ok(
    !normalized.some((name) => /\/(?:entries|content)\/admin\.js$/.test(name)),
  );
  assert.ok(!normalized.some((name) => name.endsWith("/content/index.js")));
});
