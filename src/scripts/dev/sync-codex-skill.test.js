const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { applyPlan, planSync } = require("./sync-codex-skill.js");

test("planSync detects copy, update, and extra files", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "cocalc-skill-sync-"),
  );
  try {
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");
    await fs.promises.mkdir(path.join(source, "nested"), { recursive: true });
    await fs.promises.mkdir(dest, { recursive: true });
    await fs.promises.writeFile(path.join(source, "SKILL.md"), "repo");
    await fs.promises.writeFile(path.join(source, "nested", "ref.md"), "fresh");
    await fs.promises.writeFile(path.join(dest, "SKILL.md"), "local");
    await fs.promises.writeFile(path.join(dest, "extra.md"), "extra");

    const plan = planSync(source, dest);
    assert.deepEqual(plan.copy, ["nested/ref.md"]);
    assert.deepEqual(plan.update, ["SKILL.md"]);
    assert.deepEqual(plan.extra, ["extra.md"]);
    assert.deepEqual(plan.identical, []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("applyPlan copies files and optionally deletes extras", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "cocalc-skill-sync-"),
  );
  try {
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");
    await fs.promises.mkdir(source, { recursive: true });
    await fs.promises.mkdir(dest, { recursive: true });
    await fs.promises.writeFile(path.join(source, "SKILL.md"), "repo");
    await fs.promises.writeFile(path.join(dest, "SKILL.md"), "old");
    await fs.promises.writeFile(path.join(dest, "extra.md"), "extra");

    const plan = planSync(source, dest);
    applyPlan(source, dest, plan, { deleteExtra: true, dryRun: false });

    assert.equal(
      await fs.promises.readFile(path.join(dest, "SKILL.md"), "utf8"),
      "repo",
    );
    assert.equal(fs.existsSync(path.join(dest, "extra.md")), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
