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

type ExplicitOutputFormat = "notebook" | "software" | "other";

function outputFormatFromObject(
  object: string,
): ExplicitOutputFormat | undefined {
  const words = object.match(/[\w+.-]+/g) ?? [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    // A report about software is still a report, not a software build.
    if (
      /^(?:report|summary|review|plan|guide|comparison|reference|docs|documentation|document|presentation|notes)$/.test(
        word,
      )
    ) {
      return "other";
    }
    if (
      /^(?:about|for|of|on|to|with|using|from|in|by|without|instead)$/.test(
        word,
      )
    ) {
      break;
    }
    if (
      /^(?:jupyter|jupyterlab|notebook|notebooks)$/.test(word) ||
      word.endsWith(".ipynb")
    ) {
      return "notebook";
    }
    if (
      /^(?:app|application|website|api|script|package|library|software)$/.test(
        word,
      )
    ) {
      if (
        /^(?:report|summary|review|plan|guide|comparison|reference|docs|documentation)$/.test(
          words[index + 1] ?? "",
        ) ||
        (/^(?:architecture|requirements|design)$/.test(
          words[index + 1] ?? "",
        ) &&
          /^(?:plan|document|specification|spec)$/.test(words[index + 2] ?? ""))
      ) {
        continue;
      }
      return "software";
    }
  }
  return;
}

function explicitOutputFormat(goal: string): ExplicitOutputFormat | undefined {
  let result: ExplicitOutputFormat | undefined;
  for (const rawClause of goal.split(/[.!?;\n]+/)) {
    // A goal may first describe its input, then ask for a different output.
    for (const rawAction of rawClause.split(
      /\band\s+(?=(?:build|create|write|develop|implement|make|update|edit|start)\b)/,
    )) {
      let clause = rawAction.trim();
      if (
        /^(?:do not|don't|never|i (?:do not|don't) want to|explain|describe|show how to)\b/.test(
          clause,
        )
      ) {
        continue;
      }
      clause = clause
        .replace(/^(?:(?:please|can you|could you|would you)\s+)+/, "")
        .replace(
          /^(?:(?:i|we) (?:would like|want|need) (?:you )?to|help me(?: to)?)\s+/,
          "",
        );
      const needed = clause.match(/^(?:i|we) need (.+)$/);
      if (needed) {
        result = outputFormatFromObject(needed[1]) ?? result;
        continue;
      }
      const action = clause.match(
        /^(build|create|write|develop|implement|make|update|edit|use|open|start)\s+(.+)$/,
      );
      if (!action) continue;
      const object = action[2].replace(/^(?:for me|me)\s+/, "");
      // In "Use Python to build an app", the app is the requested output;
      // Python is only the tool. Classify that affirmative purpose first.
      if (/^(?:use|open)$/.test(action[1])) {
        const purpose = object.match(
          /\bto\s+(?:build|create|write|develop|implement|make|update|edit|start)\s+(.+)$/,
        );
        if (purpose) {
          const format = outputFormatFromObject(purpose[1]);
          if (format) {
            result = format;
            continue;
          }
        }
        // An API, script, or app being used is an input/tool, not a request
        // to build a new one. An explicit notebook tool still selects its format.
        if (outputFormatFromObject(object) === "notebook") {
          result = "notebook";
        }
        continue;
      }
      result = outputFormatFromObject(object) ?? result;
    }
  }
  return result;
}

function detectCodexOnboardingMode(
  request: string,
  context?: { kind?: string; artifact?: string },
): CodexOnboardingMode {
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
  const notebookTerm = String.raw`\b(?:jupyter(?:lab)?|notebooks?|ipynb)\b`;
  const mentionsNotebook = new RegExp(notebookTerm).test(goal);
  const rulesOutNotebook =
    new RegExp(
      String.raw`\b(?:no|without)(?:\s+[\w'-]+){0,2}[\s.]+${notebookTerm}`,
    ).test(goal) ||
    new RegExp(String.raw`\bnot\s+(?:(?:a|an|the)\s+)?${notebookTerm}`).test(
      goal,
    ) ||
    new RegExp(
      String.raw`\b(?:avoid(?:\s+using)?|(?:never|don't|do not|can't|cannot|can not|should not|must not|not)\s+(?:use|using|create|make|write|build|open|run|edit|update|produce|include))(?:\s+[\w'-]+){0,2}[\s.]+${notebookTerm}`,
    ).test(goal) ||
    new RegExp(
      String.raw`${notebookTerm}\s+(?:(?:(?:is|are|was|were)\s+)?(?:not\s+(?:allowed|permitted|available|supported|wanted|used|created)|prohibited|forbidden|disallowed|unavailable|unsupported)|(?:should|must|can|could|may)\s+not\s+be\s+(?:used|created|opened|included)|(?:can't|cannot)\s+be\s+(?:used|created|opened|included)|(?:isn't|aren't)\s+(?:allowed|permitted|available|supported))\b`,
    ).test(goal);
  // The selected onboarding path is also user intent. A generic first request
  // must not discard the notebook that path already created.
  const selectedNotebook =
    ["jupyter-python", "jupyter-r", "jupyter-julia", "sage"].includes(
      context?.kind ?? "",
    ) || /\.ipynb$/i.test(`${context?.artifact ?? ""}`.trim());
  const explicitOutput = explicitOutputFormat(goal);
  if (explicitOutput === "notebook" && !rulesOutNotebook) {
    return "notebook";
  }
  // A requested software output takes precedence over the notebook starter;
  // explanation, negation, and incidental tool mentions do not.
  if (explicitOutput === "software") {
    return "software";
  }
  if (explicitOutput === "other") {
    return "general";
  }
  if (mentionsNotebook && !rulesOutNotebook) {
    return "notebook";
  }
  if (selectedNotebook && !rulesOutNotebook) {
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
  const formatGuidance = modeInstructions(
    detectCodexOnboardingMode(goal, context),
  );
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
