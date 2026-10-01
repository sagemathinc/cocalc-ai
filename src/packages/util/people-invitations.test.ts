import {
  normalizePeopleInvitationPayload as normalize,
  PEOPLE_INVITATION_LIMITS,
} from "./people-invitations";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "22222222-2222-4222-8222-222222222222";
const input = () => ({
  recipient: { kind: "account", account_id },
  projects: [{ project_id, action: "notify" }],
  message: "Hello",
  channels: { notification: true, email: false },
});

describe("people invitation exact intent", () => {
  it("canonicalizes object ordering without changing authored intent", () => {
    const p = input();
    expect(normalize({ ...p, message: "  Hello  " }).message).toBe("  Hello  ");
    expect(JSON.stringify(normalize(p))).toBe(
      JSON.stringify(normalize(JSON.parse(JSON.stringify(p)))),
    );
  });
  it("keeps email specifications separate and preserves provider-specific identity", () => {
    expect(
      normalize({
        ...input(),
        recipient: { kind: "email", email_address: " A.B+work@EXAMPLE.test " },
        projects: [
          { project_id, action: "offer_access", role: "collaborator" },
        ],
      }).recipient,
    ).toEqual({ kind: "email", email_address: "a.b+work@example.test" });
  });
  it.each([
    () => ({
      ...input(),
      recipient: {
        kind: "account",
        account_id,
        email_address: "x@example.test",
      },
    }),
    () => ({
      ...input(),
      recipient: { kind: "email", email_address: "x@example.test" },
    }),
    () => ({
      ...input(),
      projects: [{ project_id, action: "notify", role: "collaborator" }],
    }),
    () => ({
      ...input(),
      projects: [{ project_id, action: "offer_access", role: "owner" }],
    }),
    () => ({
      ...input(),
      projects: [
        {
          project_id,
          action: "offer_access",
          role: "collaborator",
          read_policy: { rules: [] },
        },
      ],
    }),
    () => ({
      ...input(),
      projects: [...input().projects, ...input().projects],
    }),
    () => ({ ...input(), projects: [] }),
    () => ({
      ...input(),
      target: { project_id, kind: "url", resource_id: "https://invalid.test" },
    }),
    () => ({
      ...input(),
      target: { project_id: account_id, kind: "artifact", resource_id: "x" },
    }),
    () => ({
      ...input(),
      message: "x".repeat(PEOPLE_INVITATION_LIMITS.message + 1),
    }),
    () => ({ ...input(), channels: { notification: "yes", email: false } }),
    () => ({ ...input(), direct: true }),
    () => ({ ...input(), message: "unsupported\x01control" }),
  ])("rejects invalid or authority-expanding payload %#", (payload) => {
    expect(() => normalize(payload())).toThrow();
  });
  it("materializes an explicit viewer policy into the reviewed payload", () => {
    const action = normalize({
      ...input(),
      projects: [{ project_id, action: "offer_access", role: "viewer" }],
    }).projects[0];
    expect(action).toMatchObject({
      role: "viewer",
      read_policy: { rules: expect.any(Array) },
    });
  });
});
