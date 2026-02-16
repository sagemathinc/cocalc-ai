# Project-Host API Routing Guide

Use this quick rule when adding features:

- If behavior depends on user identity, account policy, or project membership, use conat hub RPC.
- If behavior is host-global and does not need user auth context, HTTP may be acceptable.

## Why

- `project-host` HTTP handlers do not provide robust identity enforcement by themselves.
- Fields in request payloads (`account_id`, `project_id`) can be spoofed unless tied to authenticated conat message context.
- Conat hub methods run through arg transforms and routing that are designed for this authorization model.

## Required path for project/account APIs

1. Declare/update API method in [../conat/hub/api/projects.ts](../conat/hub/api/projects.ts).
2. Choose the auth transform (`authFirstRequireAccount`, project scoping, etc.) in that same file.
3. Implement the method in [hub/projects.ts](./hub/projects.ts).
4. If the method is called via `hub.projects.*` from the browser but must run on a project-host,
   add the method name to `PROJECT_HOST_ROUTED_HUB_METHODS` in
   [../frontend/conat/client.ts](../frontend/conat/client.ts).
5. Call from frontend via conat with a valid `project_id` so project-host routing can resolve the host.

## Example

- Codex device auth/upload belongs in conat project API
  (`projects.codexDeviceAuth*`, `projects.codexUploadAuthFile`), not `web.ts` POST routes.
- If you forget step 4, calls will go to central hub and fail with
  "not implemented on central hub; call a project-host endpoint via project routing".
