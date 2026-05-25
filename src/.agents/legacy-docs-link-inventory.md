# Legacy Docs Link Inventory

Status: planning map
Date: 2026-05-24

## Purpose

Use remaining `https://doc.cocalc.com/` links as a launch-docs backlog for
CoCalc-ai. These links point to previous-generation documentation and should not
survive launch unless explicitly allowlisted.

This inventory excludes generated build output such as
`src/packages/project/build/**`, `dist/**`, and `node_modules/**`.

Current source inventory:

- 52 legacy URL references.
- 34 unique legacy URLs.
- 52 grep lines matching `doc.cocalc.com`.

Resolved so far:

- `https://doc.cocalc.com/howto/custom-jupyter-kernel.html` now has
  `jupyter/custom-kernels` and the Jupyter custom-kernel help action points to
  `/docs/jupyter/custom-kernels`.
- `https://doc.cocalc.com/howto/low-memory.html` now has
  `troubleshooting/memory`; the project RAM warning, project OOM warning, and
  Jupyter resource usage help point to `/docs/troubleshooting/memory`.
- `https://doc.cocalc.com/apikeys.html`,
  `https://doc.cocalc.com/api2/`,
  `https://doc.cocalc.com/api2/index.html#authentication`, and the OpenAPI
  root docs URL now have `api/http-api`; the new page points automation users
  toward `cli/use-cocalc-cli` when the CLI is the better interface.
- `https://doc.cocalc.com/jupyter.html` now has `jupyter/use-jupyter`; the
  Jupyter about/help links and welcome-email Jupyter links point to the local
  docs route.
- `https://doc.cocalc.com/terminal.html` now has `terminal/use-terminal`; the
  terminal editor help link, base editor terminal help, and terminal tour links
  point to the local docs route.

## Recommended Migration Policy

Each legacy link should end in one of four states:

- `replace-existing`: replace with an existing CoCalc-ai docs route.
- `create-doc`: create a new CoCalc-ai docs page, then replace the link.
- `remove`: remove the link because the current UI text should stand alone.
- `allowlist-temporary`: keep only with an explicit reason and owner.

Before launch, add a release gate that fails on new `doc.cocalc.com` links
outside an allowlist file. The allowlist should shrink as docs pages land.

## Priority Backlog

### P0: Runtime Failure And Onboarding Docs

These links appear in warnings, first-run flows, welcome email, or API entry
points. They should be addressed before launch.

| Topic                            | Proposed CoCalc-ai docs                                                                 | Legacy URLs                                                                           | Source areas                                           | Action                      |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------- |
| Jupyter kernel termination       | existing `troubleshooting/memory`, possibly `troubleshooting/jupyter-kernel-terminated` | `/howto/jupyter-kernel-terminated.html`                                               | kernel warnings                                        | create-doc/replace-existing |
| Connectivity and browser trouble | `troubleshooting/connectivity`                                                          | `/howto/connectivity-issues.html`, `/howto/trouble.html`                              | welcome email, active content warning                  | create-doc                  |
| Welcome email docs               | `/docs` plus specific docs above                                                        | `/`, `/jupyter.html`, `/teaching-instructors.html`, `/howto/connectivity-issues.html` | `server/email/welcome-email.ts`, `server/hub/email.ts` | replace-existing/create-doc |

### P1: Account, Billing, Teaching, And Collaboration

These are user-visible and important, but they mostly need new content before
safe replacement.

| Topic                               | Proposed CoCalc-ai docs                                                       | Legacy URLs                                                                                                                         | Source areas                                                                    | Action                            |
| ----------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------- |
| SSH keys                            | `account/ssh-keys`, possibly `projects/project-ssh-keys`                      | `/account/ssh.html`, `/project-settings.html#ssh-keys`                                                                              | account SSH keys UI, project info utilities                                     | create-doc                        |
| Billing overview                    | `billing/overview`                                                            | `/billing.html`, `/project-faq.html`                                                                                                | billing FAQ                                                                     | create-doc                        |
| Licenses                            | `billing/licenses`                                                            | `/licenses.html`, `/account/licenses.html`, `/project-settings.html#project-add-license`                                            | billing data, trial banner comment                                              | create-doc                        |
| Trial and member hosting            | `billing/trial`, `billing/member-hosting`                                     | `/trial.html`, `/billing.html#what-is-member-hosting`                                                                               | project banner, trial banner                                                    | create-doc                        |
| Vouchers and dedicated host billing | `billing/vouchers`, `hosts/project-hosts`, possibly `billing/dedicated-hosts` | `/vouchers.html`, `/paygo.html`                                                                                                     | voucher center, customize constants                                             | create-doc/remove stale PAYG docs |
| Course workflow                     | `teaching/course-workflow`, existing `teaching/create-assignment`             | `/teaching-instructors.html`, `/teaching-tips_and_tricks.html#how-exactly-are-assignments-copied-to-students`                       | billing data, welcome email, file type selector, course editor, assignment info | create-doc/replace-existing       |
| Course upgrades                     | `teaching/course-upgrades` or `billing/course-upgrades`                       | `/teaching-upgrade-course.html#teacher-or-institution-pays-for-upgrades`, `/teaching-upgrade-course.html#students-pay-for-upgrades` | billing data                                                                    | create-doc                        |
| nbgrader                            | `teaching/nbgrader`                                                           | `/teaching-nbgrader.html`                                                                                                           | course config, Jupyter main, Jupyter commands                                   | create-doc                        |
| Chat and mentions                   | `collaboration/chat`, `collaboration/mentions`                                | `/chat.html`, `/teaching-interactions.html#mention-collaborators-in-chat`, `/markdown.html#mentions`                                | chat actions, notifications, file type selector                                 | create-doc                        |

### P2: Editor-Specific Help

These links can be replaced after the core docs shape stabilizes. Many should
be concise task pages rather than full manuals.

| Topic                     | Proposed CoCalc-ai docs                    | Legacy URLs                            | Source areas                                  | Action           |
| ------------------------- | ------------------------------------------ | -------------------------------------- | --------------------------------------------- | ---------------- |
| Markdown and rich text    | `files/markdown`, `editors/rich-text`      | `/markdown.html`                       | Jupyter commands, slate help, markdown editor | create-doc       |
| TimeTravel                | existing `files/timetravel`                | `/time-travel.html`                    | base editor help URL                          | replace-existing |
| LaTeX                     | `latex/build-papers`                       | `/latex.html`                          | LaTeX editor action                           | create-doc       |
| R Markdown                | `r/use-r-markdown` or `editors/r-markdown` | `/frame-editor.html#edit-rmd`          | Rmd editor action                             | create-doc       |
| Tasks                     | `projects/tasks`                           | `/tasks.html`                          | task editor action                            | create-doc       |
| Slides                    | `files/slides`                             | `/slides.html`                         | slides editor action                          | create-doc       |
| Whiteboard                | `files/whiteboard`                         | `/whiteboard.html`                     | whiteboard editor action                      | create-doc       |
| X11 apps                  | `projects/x11`                             | `/x11.html`                            | X11 editor action                             | create-doc       |
| Project list and explorer | `projects/project-list`, `files/explorer`  | `/project-list.html`, `/explorer.html` | projects tour, explorer tour                  | create-doc       |
| Internet access           | `projects/internet-access`                 | `/upgrades.html#internet-access`       | no-internet modal                             | create-doc       |

## Unique Legacy URL Map

### Jupyter

| Count | Legacy URL                                                    | Replacement                                                                                |
| ----: | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
|     1 | `https://doc.cocalc.com/howto/jupyter-kernel-terminated.html` | Create `troubleshooting/jupyter-kernel-terminated` or include in `troubleshooting/memory`. |
|     3 | `https://doc.cocalc.com/teaching-nbgrader.html`               | Create `teaching/nbgrader`.                                                                |

### Terminal, Files, And Editors

| Count | Legacy URL                                          | Replacement                                    |
| ----: | --------------------------------------------------- | ---------------------------------------------- |
|     4 | `https://doc.cocalc.com/markdown.html`              | Create `files/markdown` or `editors/markdown`. |
|     1 | `https://doc.cocalc.com/markdown.html#mentions`     | Create `collaboration/mentions`.               |
|     1 | `https://doc.cocalc.com/time-travel.html`           | Replace with existing `files/timetravel`.      |
|     1 | `https://doc.cocalc.com/latex.html`                 | Create `latex/build-papers`.                   |
|     1 | `https://doc.cocalc.com/frame-editor.html#edit-rmd` | Create `editors/r-markdown`.                   |
|     1 | `https://doc.cocalc.com/tasks.html`                 | Create `projects/tasks`.                       |
|     1 | `https://doc.cocalc.com/slides.html`                | Create `files/slides`.                         |
|     1 | `https://doc.cocalc.com/whiteboard.html`            | Create `files/whiteboard`.                     |
|     1 | `https://doc.cocalc.com/x11.html`                   | Create `projects/x11`.                         |
|     1 | `https://doc.cocalc.com/explorer.html`              | Create `files/explorer`.                       |

### Projects, Account, And API

| Count | Legacy URL                                              | Replacement                                                          |
| ----: | ------------------------------------------------------- | -------------------------------------------------------------------- |
|     1 | `https://doc.cocalc.com/project-list.html`              | Create `projects/project-list`.                                      |
|     1 | `https://doc.cocalc.com/project-settings.html#ssh-keys` | Create `projects/project-ssh-keys` or merge into `account/ssh-keys`. |
|     2 | `https://doc.cocalc.com/account/ssh.html`               | Create `account/ssh-keys`.                                           |
|     1 | `https://doc.cocalc.com/upgrades.html#internet-access`  | Create `projects/internet-access`.                                   |

### Billing And Commercial Flows

| Count | Legacy URL                                                   | Replacement                                                                                                                                               |
| ----: | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | `https://doc.cocalc.com/billing.html`                        | Create `billing/overview`.                                                                                                                                |
|     1 | `https://doc.cocalc.com/project-faq.html`                    | Create `billing/project-upgrades` or remove if stale.                                                                                                     |
|     1 | `https://doc.cocalc.com/billing.html#what-is-member-hosting` | Create `billing/member-hosting`.                                                                                                                          |
|     2 | `https://doc.cocalc.com/trial.html`                          | Create `billing/trial`.                                                                                                                                   |
|     1 | `https://doc.cocalc.com/paygo.html`                          | Remove stale pay-as-you-go language or replace with dedicated project host billing docs. Pay-as-you-go was eliminated except for dedicated project hosts. |
|     1 | `https://doc.cocalc.com/vouchers.html`                       | Create `billing/vouchers`.                                                                                                                                |
|     1 | `https://doc.cocalc.com/licenses.html`                       | Create `billing/licenses`.                                                                                                                                |
|     1 | `https://doc.cocalc.com/account/licenses.html`               | Create `billing/account-licenses`.                                                                                                                        |

### Teaching

| Count | Legacy URL                                                                                            | Replacement                                                                                                   |
| ----: | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
|     6 | `https://doc.cocalc.com/teaching-instructors.html`                                                    | Create `teaching/course-workflow`; use existing `teaching/create-assignment` for assignment-specific buttons. |
|     1 | `https://doc.cocalc.com/teaching-tips_and_tricks.html#how-exactly-are-assignments-copied-to-students` | Create `teaching/assignment-copying`.                                                                         |
|     1 | `https://doc.cocalc.com/teaching-upgrade-course.html#teacher-or-institution-pays-for-upgrades`        | Create `teaching/course-upgrades`.                                                                            |
|     1 | `https://doc.cocalc.com/teaching-upgrade-course.html#students-pay-for-upgrades`                       | Create `teaching/course-upgrades`.                                                                            |

### Collaboration, Notifications, And Troubleshooting

| Count | Legacy URL                                                                        | Replacement                                                         |
| ----: | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
|     3 | `https://doc.cocalc.com/chat.html`                                                | Create `collaboration/chat`.                                        |
|     1 | `https://doc.cocalc.com/teaching-interactions.html#mention-collaborators-in-chat` | Create `collaboration/mentions`.                                    |
|     3 | `https://doc.cocalc.com/howto/connectivity-issues.html`                           | Create `troubleshooting/connectivity`.                              |
|     1 | `https://doc.cocalc.com/howto/trouble.html`                                       | Create `troubleshooting/connectivity` or `troubleshooting/browser`. |

### Generic Root

| Count | Legacy URL                | Replacement                                              |
| ----: | ------------------------- | -------------------------------------------------------- |
|     3 | `https://doc.cocalc.com/` | Replace with `/docs`, then update nearby specific links. |

## Source File Map

### Server And API

| File                                          | Legacy topics                     | Recommended action                                                                                      |
| --------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/packages/server/email/welcome-email.ts`  | root docs, teaching, connectivity | Replace with `/docs`, `teaching/course-workflow`, `troubleshooting/connectivity`. Jupyter link is done. |
| `src/packages/server/hub/email.ts`            | root docs, teaching, connectivity | Same as welcome email; check whether this duplicates or supersedes `server/email/welcome-email.ts`.     |
| `src/packages/http-api/pages/api/v2/index.ts` | API keys, API docs root           | Done: replaced with `api/http-api` and the local docs route in OpenAPI metadata.                        |

### Billing And Account

| File                                                         | Legacy topics                       | Recommended action                                                                                                           |
| ------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/packages/frontend/customize.tsx`                        | stale Pay-as-you-go docs constant   | Remove or replace with dedicated project host billing docs. Pay-as-you-go was eliminated except for dedicated project hosts. |
| `src/packages/frontend/store/voucher-center-page.tsx`        | vouchers                            | Create `billing/vouchers`; replace link.                                                                                     |
| `src/packages/frontend/billing/faq.tsx`                      | billing, project FAQ                | Create `billing/overview`; remove stale project FAQ or replace with specific page.                                           |
| `src/packages/frontend/billing/data.ts`                      | course upgrades, teaching, licenses | Create `teaching/course-upgrades`, `teaching/course-workflow`, `billing/licenses`.                                           |
| `src/packages/frontend/components/api-keys.tsx`              | API docs                            | Done: replaced with `api/http-api` and mention that `cocalc-cli` is better for many automation workflows.                    |
| `src/packages/frontend/account/ssh-keys/ssh-key-adder.tsx`   | account SSH keys                    | Create `account/ssh-keys`; replace link.                                                                                     |
| `src/packages/frontend/account/ssh-keys/global-ssh-keys.tsx` | account SSH keys                    | Same.                                                                                                                        |

### Project Runtime And Warnings

| File                                                  | Legacy topics                    | Recommended action                                                              |
| ----------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `src/packages/frontend/project/warnings/ram.tsx`      | low memory                       | Done: replaced with `troubleshooting/memory`.                                   |
| `src/packages/frontend/project/warnings/oom.tsx`      | low memory                       | Done: replaced with `troubleshooting/memory`.                                   |
| `src/packages/frontend/jupyter/status.tsx`            | low memory                       | Done: replaced with `troubleshooting/memory`.                                   |
| `src/packages/frontend/app/active-content.tsx`        | generic trouble                  | Create `troubleshooting/connectivity`; replace link.                            |
| `src/packages/frontend/project/no-internet-modal.tsx` | internet access                  | Create `projects/internet-access`; replace link.                                |
| `src/packages/frontend/project/info/utils.ts`         | project SSH keys                 | Create `projects/project-ssh-keys`; replace link.                               |
| `src/packages/frontend/project/project-banner.tsx`    | trial                            | Create `billing/trial`; replace link.                                           |
| `src/packages/frontend/project/trial-banner.tsx`      | trial, member hosting, docs root | Create `billing/trial` and `billing/member-hosting`; keep root docs as `/docs`. |

### Teaching

| File                                                              | Legacy topics               | Recommended action                                                                                              |
| ----------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/packages/frontend/course/configuration/nbgrader.tsx`         | nbgrader                    | Create `teaching/nbgrader`; replace link.                                                                       |
| `src/packages/frontend/course/common/student-assignment-info.tsx` | assignment copying          | Create `teaching/assignment-copying`; replace link.                                                             |
| `src/packages/frontend/project/new/file-type-selector.tsx`        | chat and teaching           | Create `collaboration/chat`; replace teaching link with `teaching/course-workflow` or existing assignment docs. |
| `src/packages/frontend/frame-editors/course-editor/actions.ts`    | teaching course editor help | Create `teaching/course-workflow`; replace link.                                                                |
| `src/packages/frontend/jupyter/main.tsx`                          | nbgrader                    | Create `teaching/nbgrader`; replace link.                                                                       |
| `src/packages/frontend/jupyter/commands.ts`                       | nbgrader, Markdown          | Replace with the corresponding new docs pages. Jupyter help link is done.                                       |

### Collaboration And Notifications

| File                                                        | Legacy topics                     | Recommended action                                                       |
| ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `src/packages/frontend/chat/actions.ts`                     | chat                              | Create `collaboration/chat`; replace help command.                       |
| `src/packages/frontend/notifications/notification-page.tsx` | chat, mentions, Markdown mentions | Create `collaboration/chat` and `collaboration/mentions`; replace links. |

### Editor Help Buttons

| File                                                               | Legacy topics     | Recommended action                                                          |
| ------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------- |
| `src/packages/frontend/frame-editors/base-editor/actions-base.ts`  | TimeTravel        | Replace TimeTravel with existing `files/timetravel`. Terminal help is done. |
| `src/packages/frontend/frame-editors/terminal-editor/actions.ts`   | terminal          | Done: replaced with `terminal/use-terminal`.                                |
| `src/packages/frontend/frame-editors/terminal-editor/tour.tsx`     | terminal          | Done: replaced with `terminal/use-terminal`.                                |
| `src/packages/frontend/frame-editors/jupyter-editor/actions.ts`    | Jupyter           | Done: replaced with `jupyter/use-jupyter`.                                  |
| `src/packages/frontend/jupyter/about.tsx`                          | Jupyter           | Done: replaced with `jupyter/use-jupyter`.                                  |
| `src/packages/frontend/jupyter/browser-actions.ts`                 | custom kernels    | Done: replaced with `jupyter/custom-kernels`.                               |
| `src/packages/frontend/jupyter/kernel-warning.tsx`                 | kernel terminated | Create `troubleshooting/jupyter-kernel-terminated`; replace link.           |
| `src/packages/frontend/frame-editors/markdown-editor/actions.ts`   | Markdown          | Create `files/markdown`; replace link.                                      |
| `src/packages/frontend/editors/slate/help-modal.tsx`               | Markdown          | Create `editors/rich-text` or `files/markdown`; replace link.               |
| `src/packages/frontend/frame-editors/latex-editor/actions.ts`      | LaTeX             | Create `latex/build-papers`; replace link.                                  |
| `src/packages/frontend/frame-editors/rmd-editor/actions.ts`        | R Markdown        | Create `editors/r-markdown`; replace link.                                  |
| `src/packages/frontend/editors/task-editor/actions.ts`             | tasks             | Create `projects/tasks`; replace link.                                      |
| `src/packages/frontend/frame-editors/slides-editor/actions.ts`     | slides            | Create `files/slides`; replace link.                                        |
| `src/packages/frontend/frame-editors/whiteboard-editor/actions.ts` | whiteboard        | Create `files/whiteboard`; replace link.                                    |
| `src/packages/frontend/frame-editors/x11-editor/actions.ts`        | X11               | Create `projects/x11`; replace link.                                        |
| `src/packages/frontend/project/explorer/tour/tour.tsx`             | explorer          | Create `files/explorer`; replace link.                                      |
| `src/packages/frontend/projects/tour.tsx`                          | project list      | Create `projects/project-list`; replace link.                               |

## Suggested First Cleanup Cluster

Next cluster: connectivity and browser troubleshooting, because those links
appear in welcome/onboarding and runtime warning surfaces.

## Release Gate Shape

Add a script or docs verification step that scans source files:

```sh
rg "https://doc\\.cocalc\\.com" src/packages \
  --glob '!project/build/**' \
  --glob '!**/dist/**' \
  --glob '!**/node_modules/**'
```

The gate should:

1. Ignore generated build output.
2. Fail on any unallowlisted legacy docs URL.
3. Print the replacement category from this inventory or the allowlist.
4. Eventually become zero-tolerance before public launch.
