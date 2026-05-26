/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export async function requireManagedSshKeyAccount({
  project_id,
  fingerprint,
  resolveAccount,
}: {
  project_id: string;
  fingerprint: string;
  resolveAccount: (opts: {
    project_id: string;
    fingerprint: string;
  }) => Promise<{ account_id?: string }>;
}): Promise<string> {
  const { account_id } = await resolveAccount({ project_id, fingerprint });
  if (!account_id) {
    throw new Error("managed ssh key is no longer authorized for this project");
  }
  return account_id;
}
