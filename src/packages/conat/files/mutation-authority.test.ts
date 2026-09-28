import { fileMutationAuthority } from "./mutation-authority";
import type { ProjectHostApiKeyBinding } from "../auth/project-host-token";

const binding: ProjectHostApiKeyBinding = {
  account_id: "account",
  key_id: "key",
  scope_revision: 1,
  project_id: "project",
  placement_revision: 0,
  capabilities: ["file:read", "file:write"],
  subjects: ["fs.project-project"],
  reply_prefix: "_INBOX.first",
};
const authority = (change: Partial<ProjectHostApiKeyBinding> = {}) =>
  fileMutationAuthority({
    account_id: change.account_id ?? binding.account_id,
    auth_api_key: { ...binding, ...change },
  });

describe("file mutation authority", () => {
  it("survives reply rotation and canonicalizes capability order", () => {
    expect(authority({ reply_prefix: "_INBOX.second" })).toBe(authority());
    expect(authority({ capabilities: ["file:write", "file:read"] })).toBe(
      authority(),
    );
    expect(authority()).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each<Partial<ProjectHostApiKeyBinding>>([
    { account_id: "other" },
    { key_id: "other" },
    { scope_revision: 2 },
    { project_id: "other" },
    { placement_revision: 1 },
    { capabilities: ["file:read"] },
    { viewer_policy_hash: "a".repeat(64) },
    { subjects: ["other"] },
  ])("changes when authorization changes: %j", (change) => {
    expect(authority(change)).not.toBe(authority());
  });

  it("does not invent a credential binding for ordinary or mismatched users", () => {
    expect(fileMutationAuthority({ account_id: "account" })).toBeUndefined();
    expect(
      fileMutationAuthority({ account_id: "other", auth_api_key: binding }),
    ).toBeUndefined();
  });
});
