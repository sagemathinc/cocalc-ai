# VM Toolbox: First Working Connector Slice

Date: 2026-09-21

Branch: `feature/cocalc-ai-connectors`, PR #662 (based on the agent-first workspace).

## Try It

On lite2b, open the existing `@agent-1` in the Agents workspace. Its source project
is `6ef7fc05-39fe-479b-989c-b2c8ceb0a766`. The `connector` VM is already attached
to this human's toolbox. Click the VM count beside the composer's `+`, or choose
**+ > Virtual machine...**.

For another existing agent thread, select a running VM, enter advisory notes,
and choose **Add VM**. This configures the source project's SSH alias, runs a
bounded passwordless SSH `true` probe, and only then saves the selection. Missing
project access uses the existing VM project-access and fresh-auth flow. Existing
SSH config is preserved through the shared managed-block helper.

Ask the agent to run `hostname` and `whoami` on the selected VM. Subsequent
browser-submitted turns include the selection automatically, including after a
page reload. Notes can be edited and saved without reconfiguring SSH. **Check SSH**
is a fresh probe; **Refresh VM status** refreshes the compute observation.

## Delivered Scope

- Persistent preferences per signed-in human and stable agent identity, stored
  in account `other_settings`, not in the shared chat document.
- Several VMs per agent (maximum eight), bounded advisory notes, and removal.
- Owned and project-accessible VM discovery using existing compute APIs.
- SSH aliases of the form `cocalc-vm-<uuid>` in the source project, with public-key
  authentication and host-key checking. No provider credentials are introduced.
- VM context appended at the existing ACP submission entry point, with fresh
  project-access observations, exact IDs, aliases, and advisory notes. The
  representation does not depend on a Codex-specific tool schema.
- Explicit start action for an owned stopped VM, through existing fresh-auth
  and billing authorization. Adding a VM does not silently start it.
- Keyboard-accessible modal, responsive controls, and existing Ant Design themes.

The source-project SSH configuration is intentional shared runtime state. These
bindings are **preferences, not authorization grants**. Collaborators and code in
the source project can use its SSH key. Remote commands have the remote Unix
user's privileges. Removing a toolbox entry does not revoke SSH, terminate jobs,
stop the VM, or erase previous model context. Notes and results can become visible
in shared conversations. Project and VM files are not implicitly shared.

The UI does not promise uninterrupted VM availability: a successful probe is a
point-in-time check, and spot VMs can disappear. `expires_at` is shown as a
deletion deadline, not mislabeled as automatic shutdown.

## Validation

- Full `pnpm -C src build:dev` passed. Explicit static `build:dev` was also run to
  refresh frontend assets after frontend-only changes; the workspace incremental
  build did not always rebuild static assets automatically.
- Frontend lint passed with zero warnings/errors.
- Focused VM model/service/UI/chat tests: 19 passed. Existing SSH config helper
  tests: 5 passed.
- Live lite2b: configured and probed VM
  `062225f1-1cc6-4241-976d-64e5dd0c9cf6` (`connector`), then reloaded the page.
- Actual agent turn used passwordless SSH and returned
  `cocalc-development-vm-062225f11cc64241976d64e5` / `user`, together with the saved
  advisory notes. A second turn received the same selection without reattaching.
- Live keyboard check: Enter opens the toolbox, Escape closes it, and focus
  returns to its trigger. Dialog widths at 390px and 320px had no horizontal
  overflow. Light and dark mode were visually checked; the original system theme
  was restored. Screenshots are local under `.local/connector-evidence`.
- No VM was stopped, restarted, resized, or given different funding. No packages
  were installed on the VM. The production `opt` VM was not used.

## Remaining Work

1. Move resource resolution into a shared submission/runtime contract before
   claiming CLI, scheduled, or RPC-triggered turns inherit these preferences.
   Currently the integration is the frontend ACP submission path. Generic ACP
   harnesses have not been live-tested.
2. Add run-only selection and explicit lifecycle actions as separate UX work.
   Stop, resize, deletion and funding management remain in the existing VM UI.
   This increment supports persistent selection on an existing agent thread,
   not preselecting resources in the initial new-agent draft.
3. Live-test a second human, a course-funded student VM, stopped-VM start, and
   multi-bay routing. Current account-switch, replaced-identity, removed-access,
   and concurrent-detach cases have focused unit coverage, not a full live matrix.
4. Account preference updates use the existing whole-setting persistence API;
   concurrent edits from different tabs are last-writer-wins. SSH config updates
   reuse the existing read/upsert/write approach, not a new atomic file service.
5. Add VM alias collision diagnostics and migration when an agent's chat locator
   changes. Stable identity is checked before context delivery; the locator is
   currently also used as a fast prefilter.
6. Browser track: inventory existing Blit launch/view/cleanup; attach a dedicated,
   explicitly project-shared browser with readiness and visible control state.
   Do not expose the user's current all-purpose logged-in CDP session as a
   private or site-limited connector. In this environment the existing Chrome
   CDP endpoint was reachable on IPv6 loopback (`[::1]:9222`), not IPv4 loopback.
7. Cross-project track: reuse existing route discovery and project-to-project SSH
   setup for an explicitly broad shared-project mode, or implement the narrower
   file/exec contract in section 13. Do not label broad SSH as path-scoped or
   read-only access. Neither browser nor cross-project attachment ships here yet.

GitHub, Gmail, and Calendar remain the external connector priorities. This slice
does not add an OAuth vault, generic permission broker, or new infrastructure.
