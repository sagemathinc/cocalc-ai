const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getDocsEntry, searchDocsEntries } = require("../dist");
const essential = require("../dist/essential");

test("Claude preview and its security model are public and searchable in both catalogs", () => {
  for (const registry of [{ getDocsEntry, searchDocsEntries }, essential]) {
    const entry = registry.getDocsEntry("ai/claude-code");
    assert.ok(entry);
    assert.match(entry.title, /Experimental Preview/);
    assert.match(entry.body, /Hidden key bytes do not mean exclusive use/);
    assert.match(entry.body, /authorized Agent Network messages/);
    assert.match(entry.body, /does\s+not ask for approval before each tool/);
    assert.ok(
      registry
        .searchDocsEntries("Claude Code")
        .some((result) => result.id === entry.id),
    );
  }
});
