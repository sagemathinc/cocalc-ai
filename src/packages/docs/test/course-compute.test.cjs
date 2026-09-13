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
    "compute-funding sources --include-inactive --json",
    "vm funding VM_UUID --json",
    "Project-scoped agents cannot inspect",
    "vm personal-funding preview --terms terms.json --json",
    "vm personal-funding propose --terms terms.json --operation PROPOSAL_UUID --json",
    "vm personal-funding status VM_UUID --json",
    "approval changes the consent version",
    "--expected-version APPROVED_CONSENT_VERSION",
    "--expected-funding-version REVIEWED_FUNDING_VERSION",
    "--operation APPLY_UUID --json",
    "--operation CANCEL_UUID --json",
    "Personal handoff of attached home volumes is still backend work",
    "never remove the three course-source flags",
  ]) {
    assert.ok(guide.body.replace(/\s+/g, " ").includes(phrase), phrase);
  }
  assert.equal(verifyDocsStatic().ok, true);
});
