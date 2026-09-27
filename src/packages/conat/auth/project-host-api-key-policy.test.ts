import { isProjectHostApiKeySubjectAllowed } from "./project-host-api-key-policy";
import type { ProjectHostApiKeyBinding } from "./project-host-token";

const projectId = "00000000-0000-4000-8000-000000000001";
const otherProjectId = "00000000-0000-4000-8000-000000000002";
const base: ProjectHostApiKeyBinding = {
  account_id: "00000000-0000-4000-8000-000000000003",
  key_id: "key-id-123",
  scope_revision: 2,
  project_id: projectId,
  placement_revision: 4,
  capabilities: ["file:read"],
  viewer_policy_hash: "a".repeat(64),
  subjects: [
    `fs-api-key.project-${projectId}.account-00000000-0000-4000-8000-000000000003.key-key-id-123.rev-2.hash-${"a".repeat(64)}`,
  ],
  reply_prefix: "_INBOX.api-key-00000000-0000-4000-8000-000000000003",
};

describe("project-host API key subject confinement", () => {
  const allowed = (
    binding: ProjectHostApiKeyBinding,
    subject: string,
    type: "pub" | "sub" = "pub",
  ) => isProjectHostApiKeySubjectAllowed({ binding, subject, type });

  it("allows only its own viewer service and reply inbox", () => {
    expect(allowed(base, base.subjects[0])).toBe(true);
    expect(allowed(base, `${base.reply_prefix}.request-1`, "sub")).toBe(true);
    expect(allowed(base, `${base.reply_prefix}-other.request-1`, "sub")).toBe(
      false,
    );
    expect(allowed(base, "_INBOX.account-foreign.request-1", "sub")).toBe(
      false,
    );
    expect(allowed(base, `${base.reply_prefix}.request-1`)).toBe(false);
    expect(allowed(base, `fs.project-${projectId}`)).toBe(false);
    expect(
      allowed(
        base,
        `fs-api-key.project-${otherProjectId}.key-key-id-123.rev-2`,
      ),
    ).toBe(false);
    expect(
      allowed(base, `hub.account.00000000-0000-4000-8000-000000000004.api`),
    ).toBe(false);
  });

  it("confines full runtime to reviewed project service roots", () => {
    const full: ProjectHostApiKeyBinding = {
      ...base,
      capabilities: ["project:exec", "file:write"],
      viewer_policy_hash: undefined,
      subjects: [
        `fs.project-${projectId}`,
        `jupyter.project-${projectId}.`,
        `persist.project-${projectId}.`,
        `project.${projectId}.api.`,
        `project.${projectId}.run`,
        `terminal.project-${projectId}.`,
      ],
    };
    expect(allowed(full, `project.${projectId}.run`)).toBe(true);
    expect(allowed(full, `terminal.project-${projectId}.0`)).toBe(true);
    expect(allowed(full, `jupyter.project-${projectId}.0`)).toBe(true);
    expect(allowed(full, `persist.project-${projectId}.id`)).toBe(true);
    expect(
      allowed(full, `persist.project-${projectId}.server.shard.client`),
    ).toBe(true);
    expect(allowed(full, `persist.project-${otherProjectId}.id`)).toBe(false);
    expect(allowed(full, `persist.project-${projectId}-other.id`)).toBe(false);
    expect(allowed(full, `persist.account-${base.account_id}.id`)).toBe(false);
    expect(
      allowed(full, `persist.project-${projectId}.client.other`, "sub"),
    ).toBe(false);
    expect(allowed(base, `persist.project-${projectId}.id`)).toBe(false);
    expect(allowed(full, `project.${otherProjectId}.run`)).toBe(false);
    expect(allowed(full, `project.${projectId}.future-control.-`)).toBe(false);
    expect(allowed(full, `hub.project.${projectId}.api`)).toBe(false);
    expect(allowed(full, `file-server.${projectId}.api`)).toBe(false);
    expect(allowed(full, `project.${projectId}.>`, "sub")).toBe(false);
  });
});
