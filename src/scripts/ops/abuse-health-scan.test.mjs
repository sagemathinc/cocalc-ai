import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAccountCandidates,
  buildFileFingerprints,
  looksRandomLocalPart,
  parseFindMetadata,
} from "./abuse-health-scan.mjs";

test("recognizes generated email local parts conservatively", () => {
  assert.equal(looksRandomLocalPart("z0olbyyg"), true);
  assert.equal(looksRandomLocalPart("william.stein"), false);
  assert.equal(looksRandomLocalPart("student"), false);
});

test("scores a coordinated signup and runtime cluster as high", () => {
  const accounts = Array.from({ length: 9 }, (_, index) => ({
    account_id: `account-${index}`,
    email_address: `x${index}z9q7ab@catchall.example`,
    created_ip: "203.0.113.9",
    user_agent: "Mozilla/5.0 HeadlessChrome/151",
    primary_auth_method: "email_code",
    banned: false,
  }));
  const projects = accounts.map(({ account_id }, index) => ({
    account_id,
    project_id: `project-${index}`,
    title: "My Code",
    state: index < 7 ? "running" : "opened",
  }));
  const candidates = buildAccountCandidates(accounts, projects, 3);
  const domain = candidates.find(({ kind }) => kind === "email_domain");
  assert.equal(domain.status, "high");
  assert.ok(domain.score >= 7);
  assert.equal(domain.account_count, 9);
  assert.equal(domain.running_project_count, 7);
});

test("does not score a distributed institutional cohort", () => {
  const accounts = Array.from({ length: 6 }, (_, index) => ({
    account_id: `account-${index}`,
    email_address: `student.${index}@university.example`,
    created_ip: `198.51.100.${index + 1}`,
    user_agent: `Browser ${index}`,
    primary_auth_method: "email_code",
    banned: false,
  }));
  assert.deepEqual(buildAccountCandidates(accounts, [], 3), []);
});

test("keeps a small same-network institutional cohort at watch severity", () => {
  const accounts = Array.from({ length: 4 }, (_, index) => ({
    account_id: `account-${index}`,
    email_address: `24abc${index}9z@university.example`,
    created_ip: "198.51.100.8",
    user_agent: `Browser ${index}`,
    primary_auth_method: "email_code",
    banned: false,
  }));
  const candidates = buildAccountCandidates(accounts, [], 3);
  assert.equal(candidates[0].status, "watch");
});

test("parses NUL-delimited top-level metadata and groups fingerprints", () => {
  const host = { host_id: "host-1", name: "host one" };
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  const raw = Buffer.from(
    ids
      .map((id, index) =>
        [
          `/mnt/cocalc/project-${id}`,
          "aaa.py",
          "45325",
          `${100 + index}`,
          "",
        ].join("\0"),
      )
      .join(""),
  );
  const rows = parseFindMetadata(raw, host);
  const fingerprints = buildFileFingerprints(rows, 3);
  assert.equal(rows.length, 3);
  assert.equal(fingerprints.length, 1);
  assert.equal(fingerprints[0].name, "aaa.py");
  assert.equal(fingerprints[0].size, 45325);
  assert.deepEqual(fingerprints[0].project_ids, ids);
});
