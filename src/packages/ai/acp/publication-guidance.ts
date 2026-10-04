/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * Turn guidance for publishing chat workbench artifacts, shared by every agent
 * runtime so Codex and ACP harnesses (Claude Code) get the same expectations.
 * `cli` is the exact CoCalc CLI command for the runtime.
 */
export function artifactPublicationGuidance(
  cli: string,
  workbench: boolean,
): string {
  return workbench
    ? `Workbench is enabled for this turn. Publishing durable reviewable results is part of task completion: publish requested programs/scripts and other deliverable files as file-preview cards, written plans/documents as file references, generated images as file references, completed commits and PRs as their respective cards, and support drafts requiring approval as proposed actions. If the user explicitly asks to create, make, or publish an artifact, artifact publication is required: a normal response, file creation, image generation, or file link alone does not satisfy the request. Use ${cli} project chat artifact publish --help. A program or script created to satisfy the user's request is a deliverable even on the first onboarding turn: publish its saved file without waiting for the user to ask for a card. Do not publish incidental implementation files, temporary files, or every file touched during a task. Keep ordinary explanations and scratch work in chat. Read and update an existing artifact when revising the same object; do not duplicate it. Respect a user's request not to publish. Verify the returned publication before claiming success. Publishing proposals does not approve or execute them. If the installed command is unavailable or publication fails, report that exact failure and provide an ordinary link as a fallback; never claim an artifact was created and never write .chat files directly.`
    : `This turn has no workbench-enabled surface. Do not publish artifacts by default; use ordinary text and file links for ordinary requests. However, if the user explicitly asks to create, make, or publish an artifact, artifact publication is required. Use ${cli} project chat artifact publish --help and publish with its explicit outside-workbench opt-in (currently --experimental). A normal response, file creation, image generation, or file link alone does not satisfy an explicit artifact request. Verify the returned publication before claiming success. If the installed command is unavailable or publication fails, report that exact failure and provide an ordinary link as a fallback; never claim an artifact was created and never write .chat files directly.`;
}

// Agents otherwise approximate formulas with Unicode symbols, while CoCalc
// renders LaTeX in chat, artifacts and Markdown, including on phones.
export const MATH_FORMATTING_GUIDANCE =
  "Write mathematics as LaTeX between $...$ (inline) or $$...$$ (display); CoCalc renders it everywhere, including on phones. Do not approximate formulas with Unicode symbols.";
