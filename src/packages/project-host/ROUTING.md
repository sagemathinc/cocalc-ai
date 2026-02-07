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
4. Call from frontend via conat so project subject routing sends to the correct host.

## Example

- Codex device auth belongs in conat project API (`projects.codexDeviceAuth*`), not `web.ts` POST routes.
