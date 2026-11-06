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
  // the figures the code has: the relay's fixed 15 minutes after a turn
  // (RELAY_IDLE_MS), 10 min agent disposal, the CLI bearer's 600 s signed
  // lifetime and 30 s clock tolerance
  assert.match(
    entry.body,
    /until 15 minutes after the turn ends, whether or not it\s+is used meanwhile/,
  );
  assert.match(entry.body, /Requests still running then are stopped/);
  assert.doesNotMatch(entry.body, /without a request/);
  assert.match(entry.body, /by default 10 minutes after\s+your last turn/);
  assert.match(
    entry.body,
    /not\s+ended while a command it started in a shell is still running/,
  );
  assert.match(entry.body, /jobs\s+it started keep running/);
  assert.match(entry.body, /new relay token/);
  assert.match(entry.body, /signed for 10 minutes/);
  assert.match(
    entry.body,
    /less than 10 minutes 31 seconds\s+after it was issued/,
  );
  // the settings pins cover the settings files, not root or hooks
  assert.match(
    entry.body,
    /can't be used in a project whose image\s+contains Claude Code managed settings/,
  );
  assert.match(
    entry.body,
    /checked when the agent starts and again at each turn start/,
  );
  assert.match(
    entry.body,
    /as root in the project can still change system\s+files/,
  );
  assert.match(entry.body, /do not stop hooks or MCP servers/);
  // what it must never claim
  assert.doesNotMatch(entry.body, /\+ ?30 ?s|10 min \+/);
  assert.doesNotMatch(entry.body, /unreachable|cannot affect where/i);
  assert.doesNotMatch(entry.body, /invalidated/i);
  assert.doesNotMatch(
    entry.body,
    /every turn gets a new|new token every turn/i,
  );
  // only what the code shows: the headers it drops, and that it does not
  // check the source project (not that it cannot tell)
  assert.doesNotMatch(entry.body, /any credential header/i);
  assert.doesNotMatch(entry.body, /cannot tell/i);
  assert.doesNotMatch(entry.body, /clears any/i);
  assert.match(entry.body, /does not check which project/);
  assert.match(
    entry.body,
    /Authorization, X-Api-Key and Proxy-Authorization headers are dropped/,
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
