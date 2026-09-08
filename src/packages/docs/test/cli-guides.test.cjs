const assert = require("node:assert/strict");
const test = require("node:test");
const { getDocsEntry, searchDocsEntries } = require("../dist");

const access = { siteProfile: "cocalc-ai" };
const recipes = [
  ["install CLI", "cli.getting-started"],
  ["auth bootstrap", "cli.authentication-and-targets"],
  ["exec-api", "cli.command-reference"],
  ["exit_code", "cli.scripting-and-results"],
  ["api.text", "cli.collaborative-text"],
  ["notebook detach", "cli.notebook-workflows"],
  ["browser target-resolve", "cli.browser-workflows"],
  ["automation upsert", "cli.scheduled-agents"],
  ["workspace notices", "cli.workspaces-and-notices"],
  ["build-timeout", "cli.builds-and-versions"],
];

test("CLI recipes are registered, searchable, and avoid numeric heading IDs", () => {
  for (const [query, id] of recipes) {
    const entry = getDocsEntry(id, access);
    assert(entry, id);
    assert.equal(getDocsEntry(entry.slug, access)?.id, id);
    assert(
      searchDocsEntries(query, 3, access).some((entry) => entry.id === id),
      query,
    );
    // Numeric-leading IDs trigger selector failures in the print-view DOM tests.
    assert.doesNotMatch(entry.body, /^#{1,6} \d/m, id);
  }
});

test("remote recipes use absolute project paths and registered log commands", () => {
  for (const [id, variable] of [
    ["cli.collaborative-text", "TEXT_PATH"],
    ["cli.notebook-workflows", "NOTEBOOK_PATH"],
    ["cli.scheduled-agents", "CHAT_PATH"],
    ["cli.builds-and-versions", "DOCUMENT_PATH"],
  ]) {
    assert.match(
      getDocsEntry(id, access).body,
      new RegExp(`export ${variable}='/`),
    );
  }
  const browser = getDocsEntry("cli.browser-workflows", access).body;
  assert.match(browser, /browser logs uncaught/);
  assert.doesNotMatch(browser, /browser uncaught/);
});
