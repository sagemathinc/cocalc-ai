const assert = require("node:assert/strict");
const { test } = require("node:test");
const MarkdownIt = require("markdown-it");
const full = require("../dist");
const essential = require("../dist/essential");

const slug = "ai/agent-features";

test("agent feature reference is ordered, public, and searchable in both catalogs", () => {
  for (const registry of [full, essential]) {
    const entry = registry.getDocsEntry(slug);
    assert.ok(entry);
    assert.equal(entry.category, "AI");
    assert.equal(entry.lastReviewed, "2026-09-28");
    assert.ok(entry.noActionReason);
    const entries = registry.listDocsEntries();
    assert.equal(
      entries.findIndex((e) => e.slug === slug),
      entries.findIndex((e) => e.slug === "ai/my-agents") + 1,
    );
    for (const query of [
      "feature comparison",
      "cross-project",
      "workbench",
      "Agent Networks",
    ]) {
      assert.ok(
        registry.searchDocsEntries(query).some((r) => r.id === entry.id),
        query,
      );
    }
    for (const intro of ["ai/my-agents", "ai/codex-chat", "ai/claude-code"]) {
      assert.ok(
        registry.getDocsEntry(intro).body.includes(`/docs/${slug}`),
        intro,
      );
    }
  }
});

test("feature matrix renders as tables with valid detailed-guide links", () => {
  const entry = full.getDocsEntry(slug);
  const tokens = new MarkdownIt().parse(entry.body, {});
  assert.equal(tokens.filter((t) => t.type === "table_open").length, 7);
  assert.ok(tokens.filter((t) => t.type === "tr_open").length >= 60);
  const headings = [...entry.body.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1]);
  assert.equal(new Set(headings).size, headings.length);
  for (const [, link, anchor] of entry.body.matchAll(
    /\]\(\/docs\/([^\s)#]+)(?:#([^)]*))?\)/g,
  )) {
    const target = full.getDocsEntry(link);
    assert.ok(target, link);
    if (anchor) {
      const anchors = [...target.body.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
        m[1]
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-"),
      );
      assert.ok(anchors.includes(anchor), `${link}#${anchor}`);
    }
  }
});

test("assessment distinguishes Claude preview from full parity and unknown evidence", () => {
  const body = full.getDocsEntry(slug).body;
  for (const phrase of [
    "Claude Code remains an experimental preview",
    "Live Agent Networks that guide busy recipients | Supported | Preview",
    "Answer asynchronous questions while work continues](/docs/ai/codex-goals) | Supported | Preview",
    "Agent-to-agent messaging across projects | Supported | Unverified",
    "Continuing goals with optional token budgets](/docs/ai/codex-goals) | Supported | Not supported",
    "Schedule agent prompts](/docs/ai/codex-automation) | Supported | Not supported",
    "Accepted means admitted, not completed",
    "live-verified",
    "not a copy of project files",
    "approval is not execution",
  ])
    assert.ok(body.includes(phrase), phrase);
  const claude = full.getDocsEntry("ai/claude-code").body;
  assert.match(claude, /still need live qualification/);
  assert.match(claude, /stored payment selection/);
  assert.match(claude, /including its claude\.ai connector preference/);
  assert.match(claude, /most recent human turn in the recipient/);
  assert.match(claude, /request_user_input_async/);
  assert.match(claude, /if that turn has already finished/);
  assert.doesNotMatch(claude, /recipient path rejects ACP guidance/);
});
