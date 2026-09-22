/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";

type CodexOnboardingMode =
  | "general"
  | "latex"
  | "notebook"
  | "software"
  | "terminal";

function detectCodexOnboardingMode(request: string): CodexOnboardingMode {
  const goal = request.toLowerCase();
  if (/\b(latex|tex|bibtex|biblatex|beamer|tikz|typeset)\b/.test(goal)) {
    return "latex";
  }
  if (
    /\b(linux|unix|terminal|shell|bash|zsh|command[ -]line|cli|ssh|sysadmin)\b/.test(
      goal,
    )
  ) {
    return "terminal";
  }
  // Asking for an analysis or visualization does not select its underlying
  // editor. A mention that rules out notebooks is not a format request.
  const mentionsNotebook = /\b(jupyter(?:lab)?|notebooks?|ipynb)\b/.test(goal);
  const rulesOutNotebook =
    /\b(?:no|without|avoid|never|not|don't|do not)\b(?:\s+[\w'-]+){0,5}[\s.]+\b(?:jupyter(?:lab)?|notebooks?|ipynb)\b/.test(
      goal,
    );
  if (mentionsNotebook && !rulesOutNotebook) {
    return "notebook";
  }
  if (
    /\b(code|coding|program|software|script|app|website|package|library|api|typescript|javascript|python|rust|golang|java|c\+\+)\b/.test(
      goal,
    )
  ) {
    return "software";
  }
  return "general";
}

function modeInstructions(mode: CodexOnboardingMode): string {
  switch (mode) {
    case "latex":
      return "Create a compile-ready LaTeX deliverable. Prefer a focused .tex document plus any needed bibliography or image assets, compile it to PDF when the required tools are available, and fix compilation errors. Do not create a notebook unless the user asks for one.";
    case "terminal":
      return "Use a terminal-first workflow. Run the relevant Linux commands directly and create scripts, configuration files, or a short README when they make the result reusable. Do not create a notebook unless the user asks for one.";
    case "notebook":
      return "Prefer a runnable Jupyter notebook with concise explanatory text, executable code, and useful output already produced. Use another format only when it is clearly better for the requested result.";
    case "software":
      return "Create the appropriate source files and a short README when useful. Run the code or its focused tests and leave the project in a working state. Do not create a notebook unless the user asks for one.";
    case "general":
      return "Choose the format that best fits the requested result rather than defaulting to a notebook. Create files only when they make the result more useful or reusable.";
  }
}

export function buildCodexOnboardingPrompt(
  userRequest: string,
  context?: { kind?: string; artifact?: string },
): string {
  const goal = userRequest.trim();
  const formatGuidance = modeInstructions(detectCodexOnboardingMode(goal));
  const artifact = `${context?.artifact ?? ""}`.trim();
  const artifactPath = artifact.startsWith("/")
    ? artifact
    : `/home/user/${artifact}`;
  const workspaceState = artifact
    ? `The onboarding flow already created ${artifactPath}. Start by opening and improving that artifact when it fits the goal; replace it only when a different deliverable is clearly better.`
    : "This project was just created by the onboarding flow and is intentionally empty.";
  return `You are helping a brand-new CoCalc user complete their first useful task.

${workspaceState} Work directly in /home/user. Treat the user's goal below as a request to create a useful result, not as a request to locate files that should already exist.

<user_goal>
${goal}
</user_goal>

Complete the goal autonomously and make the first experience successful:

- Create a small, concrete, polished deliverable in /home/user that directly addresses the goal.
- ${formatGuidance}
- The user's requested output and constraints take priority over these format suggestions.
- If data or exact requirements are missing, use a clearly labeled, representative example and reasonable defaults. Do not stop merely to ask for clarification when a useful first version can be made.
- Actually run or otherwise validate what you create, inspect the result, and fix obvious errors.
- Keep the scope focused enough to finish during this onboarding turn. Favor a working demonstration that the user can extend over a broad unfinished scaffold.
- Do not search browser tabs, inspect account or project metadata, or use CoCalc CLI discovery commands. Only the onboarding artifact named above, when present, should be assumed to exist.
- Finish with the useful result in the conversation, a link to the saved deliverable, and one or two ways to refine it. Use a supported preview or inline image when suitable; do not claim that an output was displayed or opened unless it was. Offer source files and underlying tools as optional next steps unless the user asked to work in them.

Begin by creating the deliverable rather than investigating the empty project.`;
}

export function codexAvailableForOnboarding(
  paymentSource?: CodexPaymentSourceInfo,
): boolean {
  if (!paymentSource) return false;
  if (paymentSource.hasSubscription || paymentSource.hasAccountApiKey) {
    return true;
  }
  if (paymentSource.source === "shared-home") return true;
  return (
    paymentSource.hasSiteApiKey &&
    paymentSource.siteFundedCodex?.enabled === true &&
    paymentSource.siteAiUsageLimitPositive === true
  );
}

export function codexOnboardingFundingDescription(
  paymentSource?: CodexPaymentSourceInfo,
): string {
  if (paymentSource?.hasSubscription) {
    return "Uses your connected ChatGPT plan. CoCalc will not charge you per prompt.";
  }
  if (paymentSource?.hasAccountApiKey) {
    return "Uses your personal OpenAI API key. CoCalc will not add per-prompt charges.";
  }
  if (paymentSource?.source === "shared-home") {
    return "Uses this site's shared Codex access. CoCalc will not charge you per prompt.";
  }
  return "Included with your CoCalc membership. There are no per-prompt CoCalc charges.";
}
