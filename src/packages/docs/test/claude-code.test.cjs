const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getDocsEntry, searchDocsEntries } = require("../dist");
const essential = require("../dist/essential");

test("Claude access options and security model are public and searchable in both catalogs", () => {
  for (const registry of [{ getDocsEntry, searchDocsEntries }, essential]) {
    const entry = registry.getDocsEntry("ai/claude-code");
    assert.ok(entry);
    assert.match(entry.title, /Experimental Preview/);
    assert.match(entry.body, /membership includes Claude/);
    assert.match(entry.body, /Account API key/);
    assert.match(entry.body, /Project API-key secret/);
    const access = registry.getDocsEntry("ai/connect-credentials");
    assert.match(access.summary, /Codex and Claude Code/);
    assert.match(access.body, /Connect access for Claude Code/);
    assert.match(
      access.body,
      /account API key does not authorize agent-authored network/,
    );
    assert.ok(
      registry
        .searchDocsEntries("Anthropic API key")
        .some((r) => r.id === access.id),
    );
    assert.match(entry.body, /Hidden key bytes do not mean exclusive use/);
    assert.match(entry.body, /Agent Network authorization/);
    assert.match(entry.body, /authorization rechecked\s+at delivery/);
    assert.match(entry.body, /does\s+not ask for approval before each tool/);
    assert.match(entry.body, /project_exec_wait/);
    assert.match(entry.body, /not automatically replayed/);
    assert.match(entry.body, /project terminal --help/);
    assert.ok(
      registry
        .searchDocsEntries("Claude Code")
        .some((result) => result.id === entry.id),
    );
  }
});
