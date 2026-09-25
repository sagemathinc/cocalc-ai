const assert = require("node:assert/strict");
const { test } = require("node:test");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { getDocsEntry, listDocsEntries, searchDocsEntries } = require("../dist");
const { verifyDocsStatic } = require("../dist/verification");

const guides = {
  "ai/my-agents": "Start agent",
  "ai/codex-settings": "Reasoning level",
  "ai/codex-conversations": "Fork chat",
  "ai/codex-goals": "Snooze 5 minutes",
  "ai/codex-automation": "unacknowledged",
  "ai/codex-notifications": "Stop all active or uncertain",
  "ai/editor-agent": "Automatically submit to Agent",
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
    assert.equal(
      entry.lastReviewed,
      slug === "ai/my-agents" ? "2026-09-24" : "2026-09-07",
    );
    assert.ok(entry.noActionReason);
    if (slug !== "ai/my-agents") {
      assert.ok(entry.image, slug);
      assert.ok(
        existsSync(
          resolve(__dirname, "../../assets", entry.image.src.slice(1)),
        ),
      );
    }
  }
  assert.ok(
    intro.body.split("\n").length < 80,
    "keep the starting guide short",
  );
});

test("agent guides keep distinct headings and valid internal links", () => {
  const entries = listDocsEntries();
  for (const slug of [
    "ai/my-agents",
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

test("Agents guide includes its saved-result screenshot", () => {
  const body = getDocsEntry("ai/my-agents").body;
  const image = body.match(/!\[[^\]]+\]\((\/public\/docs\/[^)]+)\)/);
  assert.ok(image, "an inline screenshot should explain the review surface");
  assert.ok(
    existsSync(resolve(__dirname, "../../assets", image[1].slice(1))),
    image[1],
  );
});

test("editor recipes remain in their task guides", () => {
  for (const [slug, phrase] of [
    ["jupyter/use-jupyter", "Use Agent on a code cell"],
    ["jupyter/use-jupyter", "Improve a Markdown cell"],
    ["jupyter/use-jupyter", "Send a notebook error"],
    ["jupyter/custom-kernels", "Ask Agent to install a kernel"],
    ["latex/build-papers", "Edit a formula with Agent"],
    ["editors/r-markdown", "Ask Agent to repair a render failure"],
    ["files/git", "Set up and commit from a Codex thread"],
    ["collaboration/chat", "Resolve a LaTeX marker discussion"],
  ]) {
    assert.ok(getDocsEntry(slug)?.body.includes(phrase), `${slug}: ${phrase}`);
  }
});
