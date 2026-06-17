# Public Site Markdown And Open-Format Audit

Date: 2026-06-17

This note records the current public-site state for Markdown, project files,
open-format language, and runtime-environment framing. It is an internal
decision aid for future public-site work, not public copy.

## Executive Conclusion

Markdown should probably be more discoverable, but not as a top-level product
path or homepage promise.

The strongest public framing is:

> CoCalc keeps human-readable project files, notes, instructions, code,
> notebooks, terminals, and reusable environments together in one project.

That framing is more useful than saying "CoCalc is an operating system" or
leading with "RootFS architecture." The architecture matters, but public pages
should translate it into visitor decisions: project continuity, editable files,
agent-readable context, reusable software environments, and the right operating
model.

## Why This Matters Now

Markdown has become part of the working surface for coding agents, not only a
documentation format:

- OpenAI Codex reads `AGENTS.md` files as project instructions.
- GitHub Copilot uses Markdown custom-instruction files such as
  `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`,
  and agent instruction files such as `AGENTS.md`, `CLAUDE.md`, and
  `GEMINI.md`.
- Claude Code uses Markdown-based project memory and instruction files,
  including `CLAUDE.md`, rules, and `MEMORY.md`.

Sources checked:

- https://developers.openai.com/codex/guides/agents-md
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions
- https://docs.github.com/en/copilot/reference/custom-instructions-support
- https://docs.anthropic.com/en/docs/claude-code/memory

This supports treating Markdown as part of the AI-native project context story.
It does not by itself justify another large feature card or a new product path.

## Current Site State

Snapshot target: `https://blaec.cocalc.ai`

The DOM-level `CoCalc Crashed` heading appears in automated route snapshots; per
prior direction, this audit ignores that known QA artifact.

| Route                                                    | Current relevant coverage                                                                                                              | Markdown/open-format visibility                                                                                                    | Gap                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/`                                                      | Hero and workflow cards mention notebooks, code, documents, terminals, files, AI, teaching, and whiteboard.                            | No direct Markdown or open-format language.                                                                                        | This is probably acceptable; homepage is already intentionally compressed.                                             |
| `/features`                                              | Feature discovery covers AI, notebooks, terminals, CLI/API, LaTeX, whiteboard, slides, Linux, hosted compute, teaching, and languages. | Markdown appears only incidentally in the Slides card summary. No Markdown/docs route exists as a discoverable file-workflow path. | The feature index may underrepresent project notes, READMEs, task plans, and agent-readable instructions.              |
| `/features/ai`                                           | Strong route for Codex in the project with files, notebooks, terminals, screenshots, patches, and review notes.                        | No Markdown mention.                                                                                                               | Candidate place for one concise reference to README/project instructions if it can replace, not add to, existing text. |
| `/features/jupyter-notebook`                             | Workflow centers on notebooks, files, terminals, history, collaboration, and next steps.                                               | No Markdown mention.                                                                                                               | Probably fine; forcing Markdown here may dilute the notebook route.                                                    |
| `/features/terminal`                                     | Route explains `.term` files, shared terminal work, scripts, files, and Linux context.                                                 | `.md` is not meaningfully surfaced.                                                                                                | Could mention README/task files only if terminal page needs a stronger project-file handoff later.                     |
| `/features/linux`                                        | Public wording uses reusable environments and links to an environment-image guide.                                                     | No RootFS wording on the public route; "environment image" appears.                                                                | Good public framing. Keep RootFS in technical docs, not marketing sections.                                            |
| `/features/latex-editor`                                 | Writing route is focused on LaTeX papers, figures, build output, AI, and project files.                                                | No Markdown mention.                                                                                                               | Probably fine; Markdown belongs near files/docs, not this LaTeX route.                                                 |
| `/features/whiteboard` and `/features/slides`            | Visual workflow pages mention technical explanations, math, diagrams, Jupyter cells, collaboration.                                    | Markdown appears here because slides/whiteboards can use Markdown-style content.                                                   | This is incidental, not a discovery path for `.md` files.                                                              |
| `/products`, `/pricing`, `/features/compare`, `/support` | Product decision pages focus on operating model, licensing, fit, and support context.                                                  | No Markdown, open-format, or RootFS language.                                                                                      | Correct for now. These pages should not become file-format indexes.                                                    |
| Public docs registry                                     | Existing docs entries cover project files, file explorer, Markdown, R Markdown, task files, and runtime images/RootFS.                 | Strongest existing evidence lives in docs: `files/markdown`, `files/project-files`, `projects/runtime-image`.                      | Public-site route decisions can link to these docs instead of inventing new proof.                                     |

## Existing Source Evidence

Public docs already support a conservative Markdown path:

- `src/packages/docs/src/entries/files.ts` includes `files.markdown` with
  slug `files/markdown`, title `Use Markdown`, and summary:
  "Write README files, notes, instructions, math, code blocks, and collaborative
  documentation."
- The same file includes `files.project-files` and `files.explorer`, which
  frame the project filesystem as the shared place for notebooks, scripts,
  datasets, and output.
- `src/packages/docs/src/entries/projects.ts` includes
  `projects.runtime-image`, title `Runtime images and RootFS`, with a public
  technical-doc summary: "Choose, customize, and reuse the Linux software stack
  for a project."
- The frontend launcher includes Markdown and R Markdown as project file types.

This means a future public-site change can point to existing docs and product
behavior instead of making a new unsupported claim.

## Recommended Placement Strategy

Decision update, 2026-06-17:

- Add one low-density `Project notes and Markdown` docs link to the
  notebook/writing group on `/features`.
- Do not add a fifth visible card to that group because it risks an orphan card
  row at common desktop widths and would repeat the card-density issue this
  audit process has been removing.
- Replace one `/features/ai` phrase so Markdown is visible as editable project
  context, without exposing `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or internal
  agent-instruction conventions in public copy.
- Keep RootFS, operating-system, and broad open-format language out of public
  route copy.

Follow-up visual audit, 2026-06-17:

- Keep the `/features` Markdown surface as a supporting text link. Browser QA at
  desktop and mobile widths showed it is discoverable in the writing group while
  preserving four balanced workflow cards.
- Do not convert the Markdown link into a card. A fifth card would create a
  weaker visual rhythm and overstate Markdown relative to notebooks, LaTeX,
  whiteboards, and slides.
- Do not add Markdown to the `/features/ai` route-owned ending. The AI hero copy
  already names Markdown as editable project context; the ending should stay
  focused on the visitor's next decision: Codex, terminal agents, support, or
  product comparison.

Project-files-as-agent-context audit, 2026-06-17:

- Current external docs still support the premise: Codex reads `AGENTS.md`,
  GitHub Copilot supports repository custom-instruction Markdown files and
  agent instruction files, and Claude Code uses Markdown memory/instruction
  files. That reinforces Markdown as agent context, not as a standalone product
  promise.
- Keep Markdown itself as a supporting `/features` docs link. The broader
  buyer-facing idea belongs in `/products`: one CoCalc project model keeps files,
  notebooks, terminals, chats, and agent context together across hosted, local,
  single-VM, and private deployment paths.
- Do not create a `Project files and context` feature group yet. It would risk
  becoming an abstract taxonomy layer between workflow discovery and product
  decision, and the existing first-click routes already explain the concrete
  workflows.

### High Confidence

- Keep homepage copy unchanged for now unless a future hero/workflow pass needs
  a shorter phrase such as "project files and notes." The homepage should not
  become a file-format inventory.
- Keep RootFS out of top-level public marketing language. Use "reusable
  environments," "software stack," or "runtime image" on visitor pages, with
  RootFS reserved for technical docs.
- Treat Markdown as a project-continuity and AI-context support surface:
  README files, notes, task plans, instructions, code blocks, and collaborative
  documentation.

### Candidate Public-Site Changes To Evaluate Later

- Maintain the compact `Project notes and Markdown` route on `/features`,
  linking to `/docs/files/markdown` rather than creating a new full feature
  page.
- Keep `/features/ai` Markdown language as a replacement phrase, not a new
  section or proof block.
- On `/features/terminal`, consider one concise mention that shell work can
  leave behind scripts, READMEs, task files, and logs in the same project. This
  should happen only if it replaces existing generic file language.
- On `/features/linux`, continue linking to environment-image docs as the
  public expression of RootFS/runtime architecture.

### Avoid

- Do not say "all open format files" without a defined scope. It is too broad
  and can sound like a compatibility guarantee for every open format.
- Do not describe CoCalc as "basically an operating system" on public buyer
  pages. It is internally useful, but likely too abstract and may obscure the
  buyer question.
- Do not add another large feature card if the feature index is already close
  to the density limit. Markdown should earn its place by improving decisions,
  not by expanding the page.

## Open Questions

- Should Markdown be a visible `/features` discovery item, or should it remain a
  docs route linked from AI, terminal, and writing workflows?
- If surfaced on `/features`, should the label be `Markdown`, `Project notes`,
  or `Readable project files`? The best label depends on whether we are serving
  developer/agent workflows, researchers writing notes, or instructors writing
  handouts.
- Should the AI page explicitly mention `AGENTS.md`? This would align with
  current agent ecosystems, but it may be too implementation-specific for a
  public workflow page unless CoCalc has a first-party guide around it.
- Do we need a small "project files as context" visual somewhere, or would that
  recreate the visual-density problem we have been removing from feature pages?

## Proposed Tests If We Add Public Copy

- Assert Markdown appears at most once on the feature index if we add a
  discovery link, so it does not become decorative metadata.
- Assert `/features/ai` does not contain internal prompt/process language such
  as "agent planning notes" or competitor framing.
- Assert RootFS remains absent from high-level public feature and product pages
  except approved technical docs links.
- Assert any Markdown CTA points to `/docs/files/markdown` or another approved
  route, not a generic feature or support page.

## Next Recommended Prompt

Audit whether Markdown/project notes should become a small public discovery
surface on `/features` and `/features/ai`.

Use `docs/public-site-markdown-open-formats-audit.md`,
`docs/public-site-cohesion-audit.md`, the public docs registry, and the current
feature-index visual-density standard as source of truth. Evaluate whether
Markdown improves the AI-native project-context story enough to earn visible
surface area. If yes, make only high-confidence copy/link/test changes using
existing docs routes; if no, record the decision and leave public copy
unchanged. Keep RootFS/operating-system language in technical docs, avoid broad
open-format claims, run focused validation and browser QA, rebuild
`blaec.cocalc.ai` only if public source changes are made, commit, and report
residual risks.
