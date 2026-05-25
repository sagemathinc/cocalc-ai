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

- 17 legacy URL references.
- 15 unique legacy URLs.
- 18 grep lines matching `doc.cocalc.com`, including the docs verifier's
  diagnostic string.

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
- `https://doc.cocalc.com/howto/connectivity-issues.html` and
  `https://doc.cocalc.com/howto/trouble.html` now have
  `troubleshooting/connectivity`; the welcome-email connectivity links and
  active-content connection warning point to the local docs route.
- `https://doc.cocalc.com/howto/jupyter-kernel-terminated.html` now has
  `troubleshooting/jupyter-kernel-terminated`; the Jupyter kernel warning help
  link points to the local docs route.
- `https://doc.cocalc.com/teaching-instructors.html` now has
  `teaching/course-workflow`; the welcome emails, course editor help, new-file
  course tooltip, and billing instructor guide constant point to the local docs
  route.
- `https://doc.cocalc.com/teaching-nbgrader.html` now has
  `teaching/nbgrader`; the course nbgrader configuration and Jupyter nbgrader
  help links point to the local docs route.
- Editor help links for TimeTravel, Markdown, LaTeX, R Markdown, tasks, slides,
  whiteboard, X11 apps, the file explorer, and the projects page now point to
  local docs routes.
- `https://doc.cocalc.com/chat.html`,
  `https://doc.cocalc.com/teaching-interactions.html#mention-collaborators-in-chat`,
  and `https://doc.cocalc.com/markdown.html#mentions` now have
  `collaboration/chat` and `collaboration/mentions`; the chat help action, new
  chat tooltip, and notifications page intro point to the local docs routes.

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

| Topic                      | Proposed CoCalc-ai docs                     | Legacy URLs                             | Source areas                                           | Action |
| -------------------------- | ------------------------------------------- | --------------------------------------- | ------------------------------------------------------ | ------ |
| Jupyter kernel termination | `troubleshooting/jupyter-kernel-terminated` | `/howto/jupyter-kernel-terminated.html` | kernel warnings                                        | done   |
| Welcome email docs         | `/docs` plus specific docs above            | `/`, `/teaching-instructors.html`       | `server/email/welcome-email.ts`, `server/hub/email.ts` | done   |

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
| Course workflow                     | `teaching/course-workflow`, existing `teaching/create-assignment`             | `/teaching-instructors.html`, `/teaching-tips_and_tricks.html#how-exactly-are-assignments-copied-to-students`                       | billing data, welcome email, file type selector, course editor, assignment info | partial: instructor guide done    |
| Course upgrades                     | `teaching/course-upgrades` or `billing/course-upgrades`                       | `/teaching-upgrade-course.html#teacher-or-institution-pays-for-upgrades`, `/teaching-upgrade-course.html#students-pay-for-upgrades` | billing data                                                                    | create-doc                        |
| nbgrader                            | `teaching/nbgrader`                                                           | `/teaching-nbgrader.html`                                                                                                           | course config, Jupyter main, Jupyter commands                                   | done                              |
| Chat and mentions                   | `collaboration/chat`, `collaboration/mentions`                                | `/chat.html`, `/teaching-interactions.html#mention-collaborators-in-chat`, `/markdown.html#mentions`                                | chat actions, notifications, file type selector                                 | done                              |

### P2: Editor-Specific Help

These links can be replaced after the core docs shape stabilizes. Many should
be concise task pages rather than full manuals.

| Topic                     | Proposed CoCalc-ai docs                     | Legacy URLs                            | Source areas                                  | Action                 |
| ------------------------- | ------------------------------------------- | -------------------------------------- | --------------------------------------------- | ---------------------- |
| Markdown and rich text    | `files/markdown`, later `editors/rich-text` | `/markdown.html`                       | Jupyter commands, slate help, markdown editor | partial: Markdown done |
| TimeTravel                | existing `files/timetravel`                 | `/time-travel.html`                    | base editor help URL                          | done                   |
| LaTeX                     | `latex/build-papers`                        | `/latex.html`                          | LaTeX editor action                           | done                   |
| R Markdown                | `editors/r-markdown`                        | `/frame-editor.html#edit-rmd`          | Rmd editor action                             | done                   |
| Tasks                     | `projects/tasks`                            | `/tasks.html`                          | task editor action                            | done                   |
| Slides                    | `files/slides`                              | `/slides.html`                         | slides editor action                          | done                   |
| Whiteboard                | `files/whiteboard`                          | `/whiteboard.html`                     | whiteboard editor action                      | done                   |
| X11 apps                  | `projects/x11`                              | `/x11.html`                            | X11 editor action                             | done                   |
| Project list and explorer | `projects/project-list`, `files/explorer`   | `/project-list.html`, `/explorer.html` | projects tour, explorer tour                  | done                   |
| Internet access           | `projects/internet-access`                  | `/upgrades.html#internet-access`       | no-internet modal                             | create-doc             |

## Unique Legacy URL Map

### Jupyter

| Count | Legacy URL                                                    | Replacement                                                     |
| ----: | ------------------------------------------------------------- | --------------------------------------------------------------- |
|     1 | `https://doc.cocalc.com/howto/jupyter-kernel-terminated.html` | Done: replace with `troubleshooting/jupyter-kernel-terminated`. |
|     3 | `https://doc.cocalc.com/teaching-nbgrader.html`               | Done: replace with `teaching/nbgrader`.                         |

### Terminal, Files, And Editors

| Count | Legacy URL                                          | Replacement                                     |
| ----: | --------------------------------------------------- | ----------------------------------------------- |
|     4 | `https://doc.cocalc.com/markdown.html`              | Done: replace with `files/markdown`.            |
|     1 | `https://doc.cocalc.com/markdown.html#mentions`     | Done: replace with `collaboration/mentions`.    |
|     1 | `https://doc.cocalc.com/time-travel.html`           | Done: replace with existing `files/timetravel`. |
|     1 | `https://doc.cocalc.com/latex.html`                 | Done: replace with `latex/build-papers`.        |
|     1 | `https://doc.cocalc.com/frame-editor.html#edit-rmd` | Done: replace with `editors/r-markdown`.        |
|     1 | `https://doc.cocalc.com/tasks.html`                 | Done: replace with `projects/tasks`.            |
|     1 | `https://doc.cocalc.com/slides.html`                | Done: replace with `files/slides`.              |
|     1 | `https://doc.cocalc.com/whiteboard.html`            | Done: replace with `files/whiteboard`.          |
|     1 | `https://doc.cocalc.com/x11.html`                   | Done: replace with `projects/x11`.              |
|     1 | `https://doc.cocalc.com/explorer.html`              | Done: replace with `files/explorer`.            |

### Projects, Account, And API

| Count | Legacy URL                                              | Replacement                                                          |
| ----: | ------------------------------------------------------- | -------------------------------------------------------------------- |
|     1 | `https://doc.cocalc.com/project-list.html`              | Done: replace with `projects/project-list`.                          |
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

| Count | Legacy URL                                                                                            | Replacement                                                                                                                                              |
| ----: | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     6 | `https://doc.cocalc.com/teaching-instructors.html`                                                    | Done for known current source links: replace with `teaching/course-workflow`; use existing `teaching/create-assignment` for assignment-specific buttons. |
|     1 | `https://doc.cocalc.com/teaching-tips_and_tricks.html#how-exactly-are-assignments-copied-to-students` | Create `teaching/assignment-copying`.                                                                                                                    |
|     1 | `https://doc.cocalc.com/teaching-upgrade-course.html#teacher-or-institution-pays-for-upgrades`        | Create `teaching/course-upgrades`.                                                                                                                       |
|     1 | `https://doc.cocalc.com/teaching-upgrade-course.html#students-pay-for-upgrades`                       | Create `teaching/course-upgrades`.                                                                                                                       |

### Collaboration, Notifications, And Troubleshooting

| Count | Legacy URL                                                                        | Replacement                                  |
| ----: | --------------------------------------------------------------------------------- | -------------------------------------------- |
|     3 | `https://doc.cocalc.com/chat.html`                                                | Done: replace with `collaboration/chat`.     |
|     1 | `https://doc.cocalc.com/teaching-interactions.html#mention-collaborators-in-chat` | Done: replace with `collaboration/mentions`. |

### Generic Root

| Count | Legacy URL                | Replacement                                              |
| ----: | ------------------------- | -------------------------------------------------------- |
|     3 | `https://doc.cocalc.com/` | Replace with `/docs`, then update nearby specific links. |

## Source File Map

### Server And API

| File                                          | Legacy topics           | Recommended action                                                                                  |
| --------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| `src/packages/server/email/welcome-email.ts`  | root docs, teaching     | Replace with `/docs` and `teaching/course-workflow`. Jupyter and connectivity links are done.       |
| `src/packages/server/hub/email.ts`            | root docs, teaching     | Same as welcome email; check whether this duplicates or supersedes `server/email/welcome-email.ts`. |
| `src/packages/http-api/pages/api/v2/index.ts` | API keys, API docs root | Done: replaced with `api/http-api` and the local docs route in OpenAPI metadata.                    |

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
| `src/packages/frontend/app/active-content.tsx`        | generic trouble                  | Done: replaced with `troubleshooting/connectivity`.                             |
| `src/packages/frontend/project/no-internet-modal.tsx` | internet access                  | Create `projects/internet-access`; replace link.                                |
| `src/packages/frontend/project/info/utils.ts`         | project SSH keys                 | Create `projects/project-ssh-keys`; replace link.                               |
| `src/packages/frontend/project/project-banner.tsx`    | trial                            | Create `billing/trial`; replace link.                                           |
| `src/packages/frontend/project/trial-banner.tsx`      | trial, member hosting, docs root | Create `billing/trial` and `billing/member-hosting`; keep root docs as `/docs`. |

### Teaching

| File                                                              | Legacy topics               | Recommended action                                                                                |
| ----------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/packages/frontend/course/configuration/nbgrader.tsx`         | nbgrader                    | Create `teaching/nbgrader`; replace link.                                                         |
| `src/packages/frontend/course/common/student-assignment-info.tsx` | assignment copying          | Create `teaching/assignment-copying`; replace link.                                               |
| `src/packages/frontend/project/new/file-type-selector.tsx`        | chat and teaching           | Done: chat replaced with `collaboration/chat`; teaching replaced with `teaching/course-workflow`. |
| `src/packages/frontend/frame-editors/course-editor/actions.ts`    | teaching course editor help | Create `teaching/course-workflow`; replace link.                                                  |
| `src/packages/frontend/jupyter/main.tsx`                          | nbgrader                    | Create `teaching/nbgrader`; replace link.                                                         |
| `src/packages/frontend/jupyter/commands.ts`                       | nbgrader, Markdown          | Replace with the corresponding new docs pages. Jupyter help link is done.                         |

### Collaboration And Notifications

| File                                                        | Legacy topics                     | Recommended action                                                     |
| ----------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `src/packages/frontend/chat/actions.ts`                     | chat                              | Done: replaced with `collaboration/chat`.                              |
| `src/packages/frontend/notifications/notification-page.tsx` | chat, mentions, Markdown mentions | Done: replaced with `collaboration/chat` and `collaboration/mentions`. |

### Editor Help Buttons

| File                                                               | Legacy topics     | Recommended action                                                               |
| ------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------- |
| `src/packages/frontend/frame-editors/base-editor/actions-base.ts`  | TimeTravel        | Done: replaced with `files/timetravel`.                                          |
| `src/packages/frontend/frame-editors/terminal-editor/actions.ts`   | terminal          | Done: replaced with `terminal/use-terminal`.                                     |
| `src/packages/frontend/frame-editors/terminal-editor/tour.tsx`     | terminal          | Done: replaced with `terminal/use-terminal`.                                     |
| `src/packages/frontend/frame-editors/jupyter-editor/actions.ts`    | Jupyter           | Done: replaced with `jupyter/use-jupyter`.                                       |
| `src/packages/frontend/jupyter/about.tsx`                          | Jupyter           | Done: replaced with `jupyter/use-jupyter`.                                       |
| `src/packages/frontend/jupyter/browser-actions.ts`                 | custom kernels    | Done: replaced with `jupyter/custom-kernels`.                                    |
| `src/packages/frontend/jupyter/kernel-warning.tsx`                 | kernel terminated | Create `troubleshooting/jupyter-kernel-terminated`; replace link.                |
| `src/packages/frontend/frame-editors/markdown-editor/actions.ts`   | Markdown          | Done: replaced with `files/markdown`.                                            |
| `src/packages/frontend/editors/slate/help-modal.tsx`               | Markdown          | Done: replaced with `files/markdown`; a richer rich-text doc can be added later. |
| `src/packages/frontend/frame-editors/latex-editor/actions.ts`      | LaTeX             | Done: replaced with `latex/build-papers`.                                        |
| `src/packages/frontend/frame-editors/rmd-editor/actions.ts`        | R Markdown        | Done: replaced with `editors/r-markdown`.                                        |
| `src/packages/frontend/editors/task-editor/actions.ts`             | tasks             | Done: replaced with `projects/tasks`.                                            |
| `src/packages/frontend/frame-editors/slides-editor/actions.ts`     | slides            | Done: replaced with `files/slides`.                                              |
| `src/packages/frontend/frame-editors/whiteboard-editor/actions.ts` | whiteboard        | Done: replaced with `files/whiteboard`.                                          |
| `src/packages/frontend/frame-editors/x11-editor/actions.ts`        | X11               | Done: replaced with `projects/x11`.                                              |
| `src/packages/frontend/project/explorer/tour/tour.tsx`             | explorer          | Done: replaced with `files/explorer`.                                            |
| `src/packages/frontend/projects/tour.tsx`                          | project list      | Done: replaced with `projects/project-list`.                                     |

## Suggested First Cleanup Cluster

Next cluster: account and project SSH keys, because the remaining SSH key links
overlap and should explain both account-level keys and project access keys
without implying that every SSH key belongs in project files.

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
