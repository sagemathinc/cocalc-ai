const assert = require("node:assert/strict");
const { test } = require("node:test");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { getDocsEntry, listDocsEntries, searchDocsEntries } = require("../dist");
const { verifyDocsStatic } = require("../dist/verification");

const guides = {
  "ai/codex-settings": "Reasoning level",
  "ai/codex-conversations": "Fork chat",
  "ai/codex-goals": "Snooze 5 minutes",
  "ai/codex-automation": "unacknowledged",
  "ai/codex-notifications": "Stop all active or uncertain",
};

test("agent guides are registered, linked from the introduction, and searchable", () => {
  const intro = getDocsEntry("ai/codex-chat");
  assert.ok(intro);
  for (const [slug, phrase] of Object.entries(guides)) {
    const entry = getDocsEntry(slug);
    assert.ok(entry, slug);
    assert.ok(entry.body.includes(phrase), slug);
    assert.ok(intro.body.includes(`/docs/${slug}`), slug);
    assert.ok(
      searchDocsEntries(phrase).some((result) => result.id === entry.id),
      slug,
    );
    assert.equal(entry.lastReviewed, "2026-09-07");
    assert.ok(entry.noActionReason);
    assert.ok(
      existsSync(resolve(__dirname, "../../assets", entry.image.src.slice(1))),
    );
  }
  assert.ok(
    intro.body.split("\n").length < 80,
    "keep the starting guide short",
  );
});

test("agent guides keep distinct headings and valid internal links", () => {
  const entries = listDocsEntries();
  for (const slug of [
    "ai/codex-chat",
    "ai/connect-credentials",
    ...Object.keys(guides),
  ]) {
    const entry = getDocsEntry(slug);
    const headings = [...entry.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.equal(new Set(headings).size, headings.length, slug);
    for (const match of entry.body.matchAll(
      /\]\(\/docs\/([^\s)#]+)(?:#[^)]*)?\)/g,
    )) {
      assert.ok(
        entries.some((target) => target.slug === match[1]),
        `${slug}: ${match[1]}`,
      );
    }
  }
  assert.equal(verifyDocsStatic().ok, true);
});
