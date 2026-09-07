# Full Frontend Phone Chat Audit

Scope: make the existing full-featured Codex chat usable on iPhone 17 Pro,
preserving desktop/iPad workflows. Essential frontend is not a substitute and
has not been made discoverable as part of this work.

## Verified

- User tested on iPhone and confirmed all reported layout/composer issues fixed.
- User independently confirmed Upload files works on the phone.
- User confirmed on iPhone 17 Pro that an unsent draft survives rotation to
  landscape and back, then keyboard dismissal and reopening, with the header
  and Send button reachable throughout.
- Chrome at 320 and 402 CSS pixels: full-width input, send actions above it,
  reduced avatar-free message gutter, compact header, model/reasoning summary.
- Chrome touch emulation at 874x402 exposed a desktop-layout fallback in phone
  landscape. Compact chat now also applies to coarse-pointer viewports at most
  1000px wide and 500px tall; formatting touch targets use the same rule.
  The rebuilt page keeps header, draft input, and Send inside that viewport.
  An unsent draft survived transitions through 402x850, 874x402 touch/mouse,
  834x1194, 1194x834, and 1440x900. Mouse landscape and full-size iPad layouts
  remain noncompact. Seven focused layout tests, lint, and full build passed.
- Header model/reasoning summary opens the existing complete settings dialog;
  uses effective policy-aware settings rather than a separate configuration.
- Chrome widths 320, 402, 440, 767, 834, 1194, 1440: responsive layout switches
  without remounting the conversation. Desktop send actions remain beside input.
- Unsent text survives Rich Text to Markdown and back, leaving focused chat,
  closing the project flyout, and returning to focused chat.
- Human test message sent and reloaded in a dedicated audit chat. No audit AI
  runs, purchases, infrastructure changes, or outreach were initiated.
- Rich Text Insert menu opens the native file chooser. A text attachment was
  uploaded and inserted as a link without losing the draft; a 96x64 PNG was
  uploaded, decoded, and visibly rendered in the input. Audit drafts cleared.
- Formatting popup fits 320px, with 44px formatting buttons. Its trigger is a
  separate button, not an editing-mode radio choice. Escape/Close restore focus.
- Chats and Tools header drawers restore focus after Escape in the live browser,
  including the Chats drawer's destroy-on-close path. Six focused layout tests
  pass after this follow-up.
- Composer formatting trigger and Rich Text/Markdown controls are all 24px tall.
- Open Chats, Tools, and Text formatting panels each pass a focused axe scan
  (WCAG 2 A/AA and 2.1 AA tags) in Chrome. The scan found unnamed font-size,
  heading, and text-color buttons; labels were added and the scan rerun clean.
- Full Codex settings dialog checked at 402px and 320px without saving changes.
  Added the missing payment-source accessible name; its focused axe scan now
  passes. Usage windows fit available width instead of squeezing percentages
  into half-width cards, and model/session grids shrink below their preferred
  column width. No container overflow remains in these checks (text inputs
  retain normal internal scrolling). Screenshots confirm readable usage values.
  Both affected test suites passed: 43 tests; frontend lint and full build passed.
- Focused tests cover draft continuity, viewport changes, focus-isolation
  ownership/cleanup, mobile composer expansion, steer/queue callbacks, settings
  summary, and keyboard formatting/upload access.
- Full static builds and frontend lint passed throughout the implementation.
  Latest broad check after the message-focus follow-up: 87 chat/Markdown-input
  suites, 739 tests passed.
- Goal dialog passes its focused axe scan, including expanded Budget and usage.
  Its objective and budget fields now render at 16px in compact viewports,
  matching the composer; browser-computed styles verified after rebuilding.
  Ten focused goal tests, lint, and the full build passed after this change.
  No goal was created, modified, or saved during the browser audit.
- Expanded Codex message output fits the phone viewport and passes a focused
  axe scan. Its trigger is now named "Focus this message". Escape and the Close
  button return focus to the source message (or its trigger if still mounted),
  rather than dropping focus onto the body. The reusable Playwright check is
  `src/scripts/accessibility/chat-message-focus.mjs`: call
  `checkMessageFocus(page)` with a visible message action bar. This check opens
  with Enter and exercises both close paths without sending or editing.
  The live check, 22 focused message tests, lint, and full build passed.

## Remaining Acceptance Checks

- Broader overlay accessibility: the conversation, three primary panels, and
  Codex settings passed focused axe scans, not every nested menu, credentials
  form, or activity dialog.
- Long-running Codex approval/stop/steer/queue interactions on the actual phone
  need explicit end-to-end coverage beyond callback tests and ordinary usage.
- iPad keyboard/split-view still needs explicit device coverage; desktop width
  emulation is not equivalent. The phone rotation/keyboard sequence above has
  been confirmed by the user, not by automated Safari testing.
- Desktop Safari automation was reachable but its isolated session was not
  signed in. Real iPhone user feedback provides device evidence, not a claim of
  comprehensive automated Safari coverage.
- Changes are on the feature branch and local dev site; production rollout is
  separate. Do not treat a local build as proof of production deployment.

## Navigation Observation

Leaving focused chat restores existing project navigation, including any open
flyout. A restored flyout can cover the chat's focus button; closing its visible
X makes the button reachable and preserves the draft. This is not a chat trap,
but the general project shell still needs a separate responsive-layout pass.

## Evidence Location

Private browser screenshots/scripts are under `src/.local/mobile-chat` and
`/tmp/mobile-*.png` in the development workspace. These can contain account or
conversation data and are deliberately not committed. Test fixtures use the
dedicated `mobile-layout-audit-20260907.chat`, not the user's active conversation.
