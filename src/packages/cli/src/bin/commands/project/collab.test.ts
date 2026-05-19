import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerProjectCollabCommands } from "./collab";

function makeProgram(deps: Record<string, any>) {
  const program = new Command();
  program.name("cocalc");
  const project = program.command("project");
  registerProjectCollabCommands(project, deps as any);
  return program;
}

test("project invite create creates a copyable email-token invite", async () => {
  let result: any;
  let captured: any;
  const deps = {
    withContext: async (_command, _label, fn) => {
      result = await fn({
        accountId: "acct-1",
        hub: {
          projects: {
            inviteCollaboratorWithoutAccount: async (opts) => {
              captured = opts;
              return {
                email_sent: false,
                email_available: true,
                manual_delivery_required: true,
                email_blocked_reason: "send_disabled_by_request",
                invites: [
                  {
                    invite_id: "invite-1",
                    project_id: "project-1",
                    inviter_account_id: "acct-1",
                    invitee_account_id: null,
                    invite_source: "email",
                    status: "pending",
                    created: new Date("2026-05-18T00:00:00Z"),
                    updated: new Date("2026-05-18T00:00:00Z"),
                    invite_url:
                      "https://example.com/invites/project/project-1/invite-1?token=t",
                    target_email: "student@example.com",
                  },
                ],
              };
            },
          },
        },
      });
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project,
      title: "Course Student",
    }),
    serializeInviteRow: (row) => row,
    compactInviteRow: (row) => row,
    normalizeUserSearchName: () => "User",
    resolveAccountByIdentifier: async () => ({ account_id: "acct-2" }),
    toIso: (value) => value,
  };

  await makeProgram(deps).parseAsync([
    "node",
    "test",
    "project",
    "invite",
    "create",
    "--project",
    "project-1",
    "--email",
    "student@example.com",
  ]);

  assert.deepEqual(captured, {
    opts: {
      project_id: "project-1",
      title: "Course Student",
      link2proj: "",
      to: "student@example.com",
      email: "",
      message: undefined,
      send_email: false,
    },
  });
  assert.equal(result.email_sent, false);
  assert.equal(result.manual_delivery_required, true);
  assert.equal(result.email_blocked_reason, "send_disabled_by_request");
  assert.equal(result.invites[0].invite_url.includes("token=t"), true);
  assert.equal(result.invites[0].target_email, "student@example.com");
});

test("project invite copy-link forwards project context", async () => {
  let result: any;
  let captured: any;
  const deps = {
    withContext: async (_command, _label, fn) => {
      result = await fn({
        hub: {
          projects: {
            copyEmailProjectInviteLink: async (opts) => {
              captured = opts;
              return {
                invite_id: "invite-1",
                invite_url:
                  "https://example.com/invites/project/project-1/invite-1?token=t",
              };
            },
          },
        },
      });
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project,
      title: "Project",
    }),
    serializeInviteRow: (row) => row,
    compactInviteRow: (row) => row,
    normalizeUserSearchName: () => "User",
    resolveAccountByIdentifier: async () => ({ account_id: "acct-2" }),
    toIso: (value) => value,
  };

  await makeProgram(deps).parseAsync([
    "node",
    "test",
    "project",
    "invite",
    "copy-link",
    "invite-1",
    "--project",
    "project-1",
  ]);

  assert.deepEqual(captured, {
    invite_id: "invite-1",
    project_id: "project-1",
  });
  assert.equal(result.invite_url.includes("token=t"), true);
});
