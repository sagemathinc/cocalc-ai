/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  ProjectCollabInviteResendRequest,
  ProjectCollabInviteResendResult,
} from "@cocalc/conat/hub/api/projects";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resendPeopleInviteLocal } from "@cocalc/server/projects/people-invite-resend";
import { is_valid_uuid_string } from "@cocalc/util/misc";

export async function resendCollabInvite(
  opts: ProjectCollabInviteResendRequest & {
    account_id?: string;
    session_hash?: string;
  },
): Promise<ProjectCollabInviteResendResult> {
  if (!opts.account_id || !opts.session_hash)
    throw Error("human session required");
  if (
    process.env.COCALC_PRODUCT === "lite" ||
    !(await getServerSettings()).collaborators_enabled
  ) {
    throw Error("People invitations are unavailable on this server");
  }
  for (const key of ["project_id", "invite_id", "operation_id"] as const) {
    if (!is_valid_uuid_string(opts[key])) throw Error(`invalid ${key}`);
  }
  // This account-home check cannot be repeated against an owning bay's accounts table.
  await assertAccountTrustedForProductAccess(
    opts.account_id,
    "resend invitations",
  );
  const owner = await resolveProjectBay(opts.project_id);
  if (!owner) throw Error("project not found");
  const request = {
    account_id: opts.account_id,
    project_id: opts.project_id,
    invite_id: opts.invite_id,
    operation_id: opts.operation_id,
  };
  return owner.bay_id === getConfiguredBayId()
    ? resendPeopleInviteLocal(request)
    : getInterBayBridge().projectCollabInvite(owner.bay_id).resend(request);
}
