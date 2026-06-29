/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  create,
  disableMineByActor,
  ensurePublicDirectorySharesSchema,
  getTemporaryViewerReadPolicy,
  grantTemporaryViewerAccess,
  normalizePublicDirectorySharePath,
  normalizePublicDirectoryShareSlug,
  publicDirectoryShareReadPolicyForPath,
  update,
} from "./index";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  MAX_PUBLIC_DIRECTORY_SHARE_PROJECT_PATH_LENGTH,
  MAX_PUBLIC_DIRECTORY_SHARE_SLUG_LENGTH,
  publicDirectoryShareLabelsFromProjectLabels,
  publicDirectoryShareProjectLabelKey,
} from "@cocalc/util/public-directory-share-labels";
import { viewerReadPolicyAllowsPath } from "@cocalc/util/project-access";

let mockGetProjectFsClient: jest.Mock;

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  getProjectFsClient: (...args: any[]) => mockGetProjectFsClient(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ public_directory_shares_enabled: true }),
}));

jest.mock("@cocalc/server/conat/api/util", () => ({
  assertCollab: jest.fn(async () => undefined),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const SHARE_ID = "44444444-4444-4444-8444-444444444444";
const ASSIGNMENT_ID = "55555555-5555-4555-8555-555555555555";
const PACKAGE_ID = "66666666-6666-4666-8666-666666666666";

describe("public directory share normalization", () => {
  it("normalizes slugs", () => {
    expect(normalizePublicDirectoryShareSlug("/Cambridge/Book/Code/")).toBe(
      "Cambridge/Book/Code",
    );
  });

  it("rejects unsafe slugs", () => {
    expect(() => normalizePublicDirectoryShareSlug("")).toThrow(
      "slug must be nonempty",
    );
    expect(() => normalizePublicDirectoryShareSlug("a//b")).toThrow(
      "duplicate slashes",
    );
    expect(() => normalizePublicDirectoryShareSlug("a/../b")).toThrow(
      "path segments",
    );
    expect(() => normalizePublicDirectoryShareSlug("a/\u0000/b")).toThrow(
      "control characters",
    );
    expect(() =>
      normalizePublicDirectoryShareSlug(
        "x".repeat(MAX_PUBLIC_DIRECTORY_SHARE_SLUG_LENGTH + 1),
      ),
    ).toThrow("slug must be at most");
  });

  it("normalizes shared project paths", () => {
    expect(normalizePublicDirectorySharePath("")).toBe(".");
    expect(normalizePublicDirectorySharePath(".")).toBe(".");
    expect(normalizePublicDirectorySharePath("docs/examples/")).toBe(
      "docs/examples",
    );
    expect(normalizePublicDirectorySharePath("/home/user/x")).toBe("x");
    expect(normalizePublicDirectorySharePath("/home/user")).toBe(".");
    expect(() => normalizePublicDirectorySharePath("/root/legacy")).toThrow(
      "path must be in /home/user",
    );
    expect(() => normalizePublicDirectorySharePath("/docs/examples")).toThrow(
      "path must be in /home/user",
    );
    expect(() => normalizePublicDirectorySharePath("/tmp/share")).toThrow(
      "path must be in /home/user",
    );
  });

  it("rejects unsafe project paths", () => {
    expect(() => normalizePublicDirectorySharePath("a//b")).toThrow(
      "duplicate slashes",
    );
    expect(() => normalizePublicDirectorySharePath("a/./b")).toThrow(
      "path segments",
    );
    expect(() => normalizePublicDirectorySharePath("a/../b")).toThrow(
      "path segments",
    );
    expect(() =>
      normalizePublicDirectorySharePath(
        "x".repeat(MAX_PUBLIC_DIRECTORY_SHARE_PROJECT_PATH_LENGTH + 1),
      ),
    ).toThrow("path must be at most");
  });

  it("generates path-scoped read policies", () => {
    const policy = publicDirectoryShareReadPolicyForPath("Cambridge/Code");
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: "Cambridge/Code",
      }),
    ).toBe(true);
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: "Cambridge/Code/notebook.ipynb",
      }),
    ).toBe(true);
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: "Cambridge/Other",
      }),
    ).toBe(false);
  });

  it("excludes sensitive project paths even from root shares", () => {
    const policy = publicDirectoryShareReadPolicyForPath(".");
    expect(viewerReadPolicyAllowsPath({ policy, path: "README.md" })).toBe(
      true,
    );
    expect(viewerReadPolicyAllowsPath({ policy, path: ".ssh" })).toBe(false);
    expect(
      viewerReadPolicyAllowsPath({ policy, path: ".ssh/authorized_keys" }),
    ).toBe(false);
    expect(viewerReadPolicyAllowsPath({ policy, path: ".snapshots" })).toBe(
      false,
    );
    expect(
      viewerReadPolicyAllowsPath({ policy, path: ".snapshots/2026-06-28" }),
    ).toBe(false);
    expect(viewerReadPolicyAllowsPath({ policy, path: ".backups" })).toBe(
      false,
    );
    expect(
      viewerReadPolicyAllowsPath({ policy, path: ".backups/2026-06-28" }),
    ).toBe(false);
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: ".local/share/cocalc/project-log.db",
      }),
    ).toBe(false);
    expect(viewerReadPolicyAllowsPath({ policy, path: ".cache" })).toBe(false);
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: ".cache/cocalc/project/secrets",
      }),
    ).toBe(false);
  });

  it("excludes snapshot and backup paths even when directly shared", () => {
    for (const path of [
      ".snapshots",
      ".snapshots/a",
      ".backups",
      ".backups/a",
    ]) {
      const policy = publicDirectoryShareReadPolicyForPath(path);
      expect(viewerReadPolicyAllowsPath({ policy, path })).toBe(false);
    }
  });
});

describe("public directory temporary viewer grants", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({ reset: true });
    await ensurePublicDirectorySharesSchema();
  }, 15000);

  beforeEach(async () => {
    mockGetProjectFsClient = jest.fn(async () => ({
      getListing: jest.fn(async () => ({ files: {}, truncated: false })),
    }));
    await getPool().query(`
      TRUNCATE
        public_project_path_site_license_grants,
        public_project_path_viewer_grants,
        public_project_path_slugs,
        public_project_paths,
        project_labels
      CASCADE
    `);
  });

  afterAll(async () => {
    await getPool().end();
  });

  async function insertShare() {
    await getPool().query(
      `
        INSERT INTO projects (project_id, title, users, last_edited)
        VALUES ($1, 'Publish project', '{}'::jsonb, NOW())
        ON CONFLICT (project_id) DO NOTHING
      `,
      [PROJECT_ID],
    );
    const { rows } = await getPool().query<{ id: string }>(
      `
        INSERT INTO public_project_paths (
          id, project_id, path, slug, visibility, requires_auth,
          availability_status, created_by, updated_by, disabled
        )
        VALUES ($1, $2, 'share', 'test2', 'unlisted', TRUE, 'available', $3, $3, FALSE)
        RETURNING id
      `,
      [SHARE_ID, PROJECT_ID, OWNER_ID],
    );
    const id = rows[0].id;
    await getPool().query(
      `
        INSERT INTO public_project_path_slugs (
          slug_lower, slug, owning_bay_id, public_project_path_id, project_id,
          disabled, updated_at
        )
        VALUES (lower($1), $1, 'bay-0', $2, $3, FALSE, NOW())
      `,
      ["test2", id, PROJECT_ID],
    );
    return id;
  }

  it("validates created share paths through the account-scoped project fs client", async () => {
    await getPool().query(
      `
        INSERT INTO projects (project_id, title, users, last_edited)
        VALUES ($1, 'Publish project', '{}'::jsonb, NOW())
        ON CONFLICT (project_id) DO NOTHING
      `,
      [PROJECT_ID],
    );

    const share = await create({
      account_id: OWNER_ID,
      project_id: PROJECT_ID,
      path: "share",
      slug: "created-share",
    });

    expect(share.path).toBe("share");
    expect(mockGetProjectFsClient).toHaveBeenCalledWith({
      account_id: OWNER_ID,
      project_id: PROJECT_ID,
    });
  });

  it("grants path-scoped viewer access for a signed-in share visitor", async () => {
    const shareId = await insertShare();

    const grant = await grantTemporaryViewerAccess({
      account_id: ACCOUNT_ID,
      slug: "test2",
    });

    expect(grant.project_id).toBe(PROJECT_ID);
    expect(grant.share_id).toBe(shareId);
    expect(grant.path).toBe("share");
    expect(
      viewerReadPolicyAllowsPath({
        policy: grant.read_policy,
        path: "share/a.ipynb",
      }),
    ).toBe(true);
    expect(
      viewerReadPolicyAllowsPath({
        policy: grant.read_policy,
        path: "private/a.ipynb",
      }),
    ).toBe(false);

    const policy = await getTemporaryViewerReadPolicy({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(policy.read_policy).toEqual(grant.read_policy);
  });

  it("revokes temporary viewer grants when a share is disabled", async () => {
    const shareId = await insertShare();
    await grantTemporaryViewerAccess({
      account_id: ACCOUNT_ID,
      slug: "test2",
    });

    await update({
      account_id: OWNER_ID,
      id: shareId,
      disabled: true,
    });

    const policy = await getTemporaryViewerReadPolicy({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(policy.read_policy).toBeUndefined();
  });

  it("requires fresh auth before bulk disabling shares by actor", async () => {
    await insertShare();

    await expect(
      disableMineByActor({
        account_id: OWNER_ID,
        actor_account_id: OWNER_ID,
      }),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });
  });

  it("clears tracked site-license grants when a share is disabled", async () => {
    const shareId = await insertShare();
    await getPool().query(
      `
        INSERT INTO public_project_path_site_license_grants (
          id, public_project_path_id, assignment_id, package_id,
          target_account_id, actor_account_id, status
        )
        VALUES (
          '77777777-7777-4777-8777-777777777777',
          $1, $2, $3, $4, $5, 'active'
        )
      `,
      [shareId, ASSIGNMENT_ID, PACKAGE_ID, ACCOUNT_ID, OWNER_ID],
    );

    await update({
      account_id: OWNER_ID,
      id: shareId,
      disabled: true,
    });

    const { rows } = await getPool().query<{ status: string }>(
      `
        SELECT status
        FROM public_project_path_site_license_grants
        WHERE public_project_path_id=$1
      `,
      [shareId],
    );
    expect(rows).toEqual([{ status: "stale" }]);
  });

  it("syncs generated project labels for active public shares", async () => {
    const shareId = await insertShare();

    await update({
      account_id: OWNER_ID,
      id: shareId,
      title: "Published test share",
    });

    const { rows } = await getPool().query<{ key: string; value: string }>(
      `
        SELECT key, value
        FROM project_labels
        WHERE project_id=$1
        ORDER BY key
      `,
      [PROJECT_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(publicDirectoryShareProjectLabelKey(shareId));
    expect(
      publicDirectoryShareLabelsFromProjectLabels({
        [rows[0].key]: rows[0].value,
      }),
    ).toEqual([
      expect.objectContaining({
        id: shareId,
        path: "share",
        slug: "test2",
        title: "Published test share",
        visibility: "unlisted",
      }),
    ]);
  });

  it("removes generated project labels when a public share is disabled", async () => {
    const shareId = await insertShare();
    await update({
      account_id: OWNER_ID,
      id: shareId,
      title: "Published test share",
    });

    await update({
      account_id: OWNER_ID,
      id: shareId,
      disabled: true,
    });

    const { rows } = await getPool().query<{ key: string; value: string }>(
      `
        SELECT key, value
        FROM project_labels
        WHERE project_id=$1
          AND key=$2
      `,
      [PROJECT_ID, publicDirectoryShareProjectLabelKey(shareId)],
    );
    expect(rows).toEqual([]);
  });
});
