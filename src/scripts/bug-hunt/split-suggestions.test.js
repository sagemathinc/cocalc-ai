const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSplitSuggestions,
  formatHumanSuggestions,
  scorePathForArea,
  tokenizeArea,
} = require("./split-suggestions.js");

test("tokenizeArea splits on punctuation and removes tiny tokens", () => {
  assert.deepEqual(tokenizeArea("frontend/chat"), ["frontend", "chat"]);
  assert.deepEqual(tokenizeArea("bug-hunt"), ["bug", "hunt"]);
});

test("scorePathForArea prefers paths containing area tokens", () => {
  assert.ok(scorePathForArea("scripts/bug-hunt/commit.js", "bug-hunt") > 0);
  assert.equal(
    scorePathForArea("packages/frontend/chat/input.tsx", "jupyter"),
    0,
  );
});

test("buildSplitSuggestions groups files under pending ledger entries", () => {
  const payload = buildSplitSuggestions(
    [
      "scripts/bug-hunt/commit.js",
      "packages/frontend/chat/input.tsx",
      "packages/frontend/jupyter/select-kernel.tsx",
      "README.md",
    ],
    [
      {
        iteration: 3,
        task_id: "task-3",
        area: "bug-hunt",
        result: "bug_fixed",
      },
      {
        iteration: 2,
        task_id: "task-2",
        area: "frontend/chat",
        result: "bug_fixed",
      },
      {
        iteration: 1,
        task_id: "task-1",
        area: "jupyter",
        result: "already_fixed",
      },
    ],
    10,
  );
  assert.equal(payload.suggestions.length, 3);
  assert.deepEqual(payload.unmatched, ["README.md"]);
});

test("formatHumanSuggestions renders grouped files and unmatched leftovers", () => {
  const text = formatHumanSuggestions({
    suggestions: [
      {
        iteration: 2,
        task_id: "task-2",
        area: "frontend/chat",
        suggested_subject_prefix: "frontend/chat",
        files: ["packages/frontend/chat/input.tsx"],
      },
    ],
    unmatched: ["README.md"],
  });
  assert.match(text, /task-2 frontend\/chat/);
  assert.match(text, /subject prefix: frontend\/chat/);
  assert.match(text, /README.md/);
});
