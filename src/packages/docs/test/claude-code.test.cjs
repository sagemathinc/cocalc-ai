const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getDocsEntry, searchDocsEntries } = require("../dist");
const essential = require("../dist/essential");

test("Claude access options and security model are public and searchable in both catalogs", () => {
  for (const registry of [{ getDocsEntry, searchDocsEntries }, essential]) {
    const entry = registry.getDocsEntry("ai/claude-code");
    assert.ok(entry);
    // Not a preview since 2026-10-27 (William).
    assert.equal(entry.title, "Claude Code in CoCalc");
    assert.doesNotMatch(entry.body, /experimental preview/i);
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

test("the page on Claude subscriptions in the project states the code's limits, not more", () => {
  const entry = getDocsEntry("ai/claude-subscription-in-project");
  assert.ok(entry);
  // the figures the code has: 15 min relay idle, 10 min agent disposal
  assert.match(entry.body, /15 minutes without a request/);
  assert.match(entry.body, /by default 10 minutes after\s+your last turn/);
  assert.match(entry.body, /new relay token/);
  // what it must never claim
  assert.doesNotMatch(entry.body, /invalidated/i);
  assert.doesNotMatch(
    entry.body,
    /every turn gets a new|new token every turn/i,
  );
  // the collaborator warning, as approved
  assert.match(entry.body, /CoCalc cannot protect you from a\s+collaborator/);
  assert.match(entry.body, /violates Anthropic's terms of service/);
  // unverified items stay marked as such
  assert.match(entry.body, /Not yet confirmed in a live session/);
  assert.ok(
    searchDocsEntries("Claude subscription collaborators relay token").some(
      (r) => r.id === entry.id,
    ),
  );
  assert.match(
    getDocsEntry("ai/claude-code").body,
    /\/docs\/ai\/claude-subscription-in-project/,
  );
});
