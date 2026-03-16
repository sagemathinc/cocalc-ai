const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyEntries,
  normalizeEntryPaths,
  parseGitStatusPorcelainZ,
} = require("./preflight.js");

test("parseGitStatusPorcelainZ handles tracked, untracked, and renames", () => {
  const entries = parseGitStatusPorcelainZ(
    " M packages/frontend/chat/chatroom.tsx\0?? .agents/bug-hunt/log.md\0R  new-name.ts\0old-name.ts\0",
  );

  assert.deepEqual(entries, [
    {
      status: " M",
      path: "packages/frontend/chat/chatroom.tsx",
      originalPath: undefined,
    },
    { status: "??", path: ".agents/bug-hunt/log.md", originalPath: undefined },
    { status: "R ", path: "new-name.ts", originalPath: "old-name.ts" },
  ]);
});

test("classifyEntries allows bug-hunt logs but blocks source edits", () => {
  const result = classifyEntries(
    [
      { status: "??", path: ".agents/bug-hunt/run.md" },
      { status: "??", path: "../wstein.tasks" },
      { status: "??", path: "packages/frontend/chat/new-test.tsx" },
      { status: " M", path: "packages/frontend/chat/chatroom.tsx" },
    ],
    {
      allowedUntrackedPrefixes: [".agents/bug-hunt/"],
      allowedExactPaths: ["../wstein.tasks"],
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.untrackedAllowed.map((entry) => entry.path),
    [".agents/bug-hunt/run.md", "../wstein.tasks"],
  );
  assert.deepEqual(
    result.untrackedBlocking.map((entry) => entry.path),
    ["packages/frontend/chat/new-test.tsx"],
  );
  assert.deepEqual(
    result.tracked.map((entry) => entry.path),
    ["packages/frontend/chat/chatroom.tsx"],
  );
});

test("normalizeEntryPaths converts git-root paths back to repo-relative paths", () => {
  const entries = normalizeEntryPaths(
    [
      { status: " M", path: "src/package.json" },
      { status: "??", path: "src/.agents/bug-hunt/run.md" },
      { status: "??", path: "wstein.tasks" },
    ],
    "/repo/src",
    "/repo",
  );

  assert.deepEqual(entries, [
    { status: " M", path: "package.json" },
    { status: "??", path: ".agents/bug-hunt/run.md" },
    { status: "??", path: "../wstein.tasks" },
  ]);
});
