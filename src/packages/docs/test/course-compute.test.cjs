const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getDocsEntry } = require("../dist");
const { verifyDocsStatic } = require("../dist/verification");

test("course compute guide distinguishes authorization, reservations, and remote data", () => {
  const guide = getDocsEntry("teaching/course-compute", {
    siteProfile: "cocalc-ai",
  });
  assert.ok(guide);
  assert.equal(guide.status, "draft");
  for (const phrase of [
    "student-owned",
    "separate financial approval",
    "Available to start",
    "no automatic file synchronization",
    "They remain in your project",
    "does not use vouchers",
    "personal credit or a payment card",
  ]) {
    assert.ok(guide.body.replace(/\s+/g, " ").includes(phrase), phrase);
  }
  assert.equal(verifyDocsStatic().ok, true);
});
