import { createHash } from "node:crypto";
import type { ProjectHostApiKeyBinding } from "../auth/project-host-token";

/** Derived only from the authenticated principal, never from RPC arguments. */
export function fileMutationAuthority(user: {
  account_id?: string;
  auth_api_key?: ProjectHostApiKeyBinding;
}): string | undefined {
  const binding = user?.auth_api_key;
  if (!binding || !user.account_id || binding.account_id !== user.account_id)
    return undefined;
  // Lease expiry and reply inbox change on healthy renewal. All authorization
  // dimensions remain bound; placement changes must not reuse old outcomes.
  // Receipts themselves are process-local, so a different host has no receipt.
  return createHash("sha256")
    .update(
      JSON.stringify([
        "file-mutation-v1",
        binding.account_id,
        binding.key_id,
        binding.scope_revision,
        binding.project_id,
        binding.placement_revision,
        [...binding.capabilities].sort(),
        binding.viewer_policy_hash ?? null,
        [...binding.subjects].sort(),
      ]),
    )
    .digest("hex");
}
