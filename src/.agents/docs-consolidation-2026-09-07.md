# Agent Documentation Consolidation, 2026-09-07

Consolidates the 38 `docs:` PRs that were open when reviewed on September 7, based on
`82bbbbfd9d`. Original content by **Blaec-CoCalc**; consolidated commits retain
co-author attribution. Overlapping #478 remains open. This four-PR alternative is
ready for review only: do not merge or close anything without maintainer approval.

At the final audit, Blaec-CoCalc had independently closed 22 originals in the
#427-#453 range within this scope. All 38 source heads still matched the reviewed
mapping. This task has not merged, closed, or reopened any PR.

## Review Order

1. [Access and settings, #479](https://github.com/sagemathinc/cocalc-ai/pull/479), based on main:
   #434, #435, #436, #437, #438, #442, #469, #470.
2. [Conversations and automation, #480](https://github.com/sagemathinc/cocalc-ai/pull/480), based on #479:
   #439, #440, #441, #444, #445, #447, #448, #449, #450, #467, #468.
3. [Editor workflows, #481](https://github.com/sagemathinc/cocalc-ai/pull/481), based on #480:
   #446, #451, #452, #453, #454, #455 (guide only), #456, #457, #458, #459, #460, #465, #466.
4. [Developer reference, #482](https://github.com/sagemathinc/cocalc-ai/pull/482), independently based on main:
   #427, #428, #433, #462, #463, #464.

The first three form a review stack so each incremental diff has working links
and passing tests. The developer-reference PR may be reviewed independently.
Do not merge this series alongside #478: they consolidate the same topics.
The mobile-navigation/payment corrections from #478 were source-checked and
incorporated; its notebook section ordering is retained. No inline bot review
comments were present when checked.

## Organization

- Setup and access: retain the credentials page and add a focused chat-settings guide.
- Conversations and automation: separate steering/forks, goals/questions, scheduled
  work, and notifications/session monitoring. Keep the getting-started page short.
- Editor workflows: retain notebook, LaTeX, R Markdown, Git and collaboration
  instructions on their existing pages; link common popup guidance.
- Developer reference: preserve CLI recipes, chat-import skill correction,
  browser API policy distinctions and SDK deployment limitations.

No new images were necessary. The new guides reuse the existing Codex WebP icon;
tests verify that its file exists. No product-code changes are included. #455's public frontend JSX feature-page
copy correction is deliberately excluded; only its user-guide addition is carried
forward. That small excluded change remains available in the original PR.

## Source Review

Reviewed against these implementations; this is source evidence, not a claim
that all remote services and every user workflow were exercised:

| Area                           | Implementation checked                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Access and payment             | frontend/chat/codex.tsx, ai/acp/codex-app-server.ts                                                  |
| Model defaults and concurrency | frontend/chat/codex-defaults.ts, frontend/account/codex-subagent-concurrency.tsx                     |
| Steering, queues and context   | frontend/chat/composer.tsx, frontend/chat/actions.ts                                                 |
| Goals and questions            | frontend/chat/codex-goal.tsx, frontend/chat/codex-attention-card.tsx                                 |
| Schedules and acknowledgment   | frontend/chat/automation-form.tsx, lite/hub/acp/index.ts                                             |
| Sessions and notifications     | frontend/account/codex-sessions-panel.tsx, frontend/notifications/codex-turn-toast.ts                |
| Editor requests and formulas   | frontend/frame-editors/latex-editor/rich-edit/widget-manager.tsx, frontend/chat/acp-prompt-modal.tsx |
| Git                            | frontend/chat/git-commit-prompt.ts, frontend/chat/git-commit-drawer.tsx                              |
| CLI continuation               | cli/src/bin/commands/project/codex.ts, cli/src/bin/core/project-codex.ts                             |
| CLI chat import                | cli/src/bin/commands/import.ts, cli/src/bin/commands/export.ts                                       |
| Workspace messages             | cli/src/bin/core/workspace-chat.ts, cli/src/bin/commands/workspaces.ts                               |
| SDK                            | ai/agent-sdk/runtime.ts, server/conat/api/agent.ts, lite/hub/agent.ts                                |

Exact session-list/stop record limits were replaced by the user-facing bounded
operation caveat. Source behavior can change; refresh the relevant guide when
changing UI labels or these contracts. Review dates on changed entries reflect
this source/editorial review, not end-to-end certification.

## Validation

- Documentation TypeScript build and static verifier at each stack level:
  86, 90, then 91 entries; 57 actions and no issues at each level.
- New Node tests for guide registration, introductory links, search discovery,
  unique headings, internal links, image existence and editor recipe placement.
- Frontend lint passed during the combined draft validation; its frontend copy
  edit was subsequently removed from scope.
- Installed CLI help checked for Codex continuation, daily automation and workspace
  messages. No paid Codex requests or credential mutations used as smoke tests.
- All seven added shell examples pass `bash -n`; the four developer documents
  render with Markdown-it and their relative file links resolve. This check is
  scoped to added shell examples: existing examples containing placeholder
  syntax such as `<spawn_id_or_browser_id>` are not executable shell scripts.
- Live lite4b existing chat menu inspected; Fork and Behavior controls available.
  Browser reports an older frontend build, so this checks workflow labels only,
  not rendering of the new docs in the deployed application.
- A Markdown-it smoke rendered 14 changed/related guides after the same
  escaped-backtick normalization used by the docs browser; headings and fenced
  code were checked. This is not a full-site visual or accessibility test.
- Full site rebuild/deployment and end-to-end funded turns, scheduled execution,
  remote authentication, kernel installs and document repair are not covered.

## Source PR Mapping

| PR                                                        | Source head  | Consolidated destination                         |
| --------------------------------------------------------- | ------------ | ------------------------------------------------ |
| [#427](https://github.com/sagemathinc/cocalc-ai/pull/427) | `604830a6cf` | src/packages/cli/skills/cocalc/SKILL.md          |
| [#428](https://github.com/sagemathinc/cocalc-ai/pull/428) | `bc823f1431` | src/packages/ai/agent-sdk/README.md              |
| [#433](https://github.com/sagemathinc/cocalc-ai/pull/433) | `3b38d20621` | docs/api.md                                      |
| [#434](https://github.com/sagemathinc/cocalc-ai/pull/434) | `57a67d8949` | /docs/ai/codex-settings                          |
| [#435](https://github.com/sagemathinc/cocalc-ai/pull/435) | `ef9d505fa5` | /docs/ai/connect-credentials                     |
| [#436](https://github.com/sagemathinc/cocalc-ai/pull/436) | `2e40c796db` | /docs/ai/connect-credentials                     |
| [#437](https://github.com/sagemathinc/cocalc-ai/pull/437) | `8f0370bcb4` | /docs/ai/codex-settings                          |
| [#438](https://github.com/sagemathinc/cocalc-ai/pull/438) | `7b458c58af` | /docs/ai/codex-settings                          |
| [#439](https://github.com/sagemathinc/cocalc-ai/pull/439) | `42bd479b7f` | /docs/ai/codex-conversations                     |
| [#440](https://github.com/sagemathinc/cocalc-ai/pull/440) | `c2a5e1ebb5` | /docs/ai/codex-conversations                     |
| [#441](https://github.com/sagemathinc/cocalc-ai/pull/441) | `2f91a9504c` | /docs/ai/codex-notifications                     |
| [#442](https://github.com/sagemathinc/cocalc-ai/pull/442) | `1a66411a16` | /docs/ai/codex-settings                          |
| [#444](https://github.com/sagemathinc/cocalc-ai/pull/444) | `2ebe040dfe` | /docs/ai/codex-conversations                     |
| [#445](https://github.com/sagemathinc/cocalc-ai/pull/445) | `433e2250d6` | /docs/ai/codex-conversations                     |
| [#446](https://github.com/sagemathinc/cocalc-ai/pull/446) | `23d7000e53` | /docs/ai/editor-agent                            |
| [#447](https://github.com/sagemathinc/cocalc-ai/pull/447) | `16fd01ff75` | /docs/ai/codex-notifications                     |
| [#448](https://github.com/sagemathinc/cocalc-ai/pull/448) | `9013f68274` | /docs/ai/codex-automation                        |
| [#449](https://github.com/sagemathinc/cocalc-ai/pull/449) | `427802a4a0` | /docs/ai/codex-automation                        |
| [#450](https://github.com/sagemathinc/cocalc-ai/pull/450) | `4d2bf686ae` | /docs/ai/codex-automation                        |
| [#451](https://github.com/sagemathinc/cocalc-ai/pull/451) | `1b8e5193e5` | /docs/jupyter/use-jupyter                        |
| [#452](https://github.com/sagemathinc/cocalc-ai/pull/452) | `9e4c9fb675` | /docs/jupyter/use-jupyter                        |
| [#453](https://github.com/sagemathinc/cocalc-ai/pull/453) | `819ed11c79` | /docs/jupyter/use-jupyter                        |
| [#454](https://github.com/sagemathinc/cocalc-ai/pull/454) | `73a1a3affb` | /docs/jupyter/custom-kernels                     |
| [#455](https://github.com/sagemathinc/cocalc-ai/pull/455) | `e57d6b5f2f` | /docs/latex/build-papers only; JSX copy excluded |
| [#456](https://github.com/sagemathinc/cocalc-ai/pull/456) | `9eced8a4bb` | /docs/latex/build-papers                         |
| [#457](https://github.com/sagemathinc/cocalc-ai/pull/457) | `d3eaf0c93d` | /docs/editors/r-markdown                         |
| [#458](https://github.com/sagemathinc/cocalc-ai/pull/458) | `0a3d513ba5` | /docs/ai/editor-agent                            |
| [#459](https://github.com/sagemathinc/cocalc-ai/pull/459) | `b4816d0dd0` | /docs/ai/editor-agent                            |
| [#460](https://github.com/sagemathinc/cocalc-ai/pull/460) | `9b79f21ca6` | /docs/ai/editor-agent                            |
| [#462](https://github.com/sagemathinc/cocalc-ai/pull/462) | `f592a20878` | src/packages/cli/README.md                       |
| [#463](https://github.com/sagemathinc/cocalc-ai/pull/463) | `88e457717f` | src/packages/cli/README.md                       |
| [#464](https://github.com/sagemathinc/cocalc-ai/pull/464) | `90da384269` | src/packages/cli/README.md                       |
| [#465](https://github.com/sagemathinc/cocalc-ai/pull/465) | `6f9463ee24` | /docs/files/git                                  |
| [#466](https://github.com/sagemathinc/cocalc-ai/pull/466) | `48cd3c3eb0` | /docs/collaboration/chat                         |
| [#467](https://github.com/sagemathinc/cocalc-ai/pull/467) | `6da20826b0` | /docs/ai/codex-goals                             |
| [#468](https://github.com/sagemathinc/cocalc-ai/pull/468) | `8f834e0b83` | /docs/ai/codex-goals                             |
| [#469](https://github.com/sagemathinc/cocalc-ai/pull/469) | `3e77e05acf` | /docs/ai/connect-credentials                     |
| [#470](https://github.com/sagemathinc/cocalc-ai/pull/470) | `4fe397dee6` | /docs/ai/codex-settings                          |
