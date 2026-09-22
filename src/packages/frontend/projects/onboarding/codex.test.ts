import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import {
  buildCodexOnboardingPrompt,
  codexAvailableForOnboarding,
  codexOnboardingFundingDescription,
} from "./codex";

function source(
  value: Partial<CodexPaymentSourceInfo>,
): CodexPaymentSourceInfo {
  return {
    source: "none",
    hasSubscription: false,
    hasProjectApiKey: false,
    hasAccountApiKey: false,
    hasSiteApiKey: false,
    sharedHomeMode: "disabled",
    ...value,
  };
}

describe("Codex onboarding availability", () => {
  it("turns a first-project goal into an action-oriented hidden prompt", () => {
    const prompt = buildCodexOnboardingPrompt(
      "  See benchmarks of some basic number theory algorithms.  ",
    );

    expect(prompt).toContain(
      "<user_goal>\nSee benchmarks of some basic number theory algorithms.\n</user_goal>",
    );
    expect(prompt).toContain("project was just created");
    expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).toContain("Actually run or otherwise validate");
    expect(prompt).toContain("Do not search browser tabs");
    expect(prompt).toContain("Begin by creating the deliverable");
  });

  it.each<[string, string, boolean]>([
    ["Write my first LaTeX paper with BibTeX", "compile-ready LaTeX", true],
    ["Teach me Linux terminal commands", "terminal-first workflow", true],
    ["Build a small TypeScript app", "appropriate source files", true],
    ["Help me organize my research ideas", "best fits", false],
  ])(
    "uses request-specific guidance for %s",
    (request, expected, excludesNotebook) => {
      const prompt = buildCodexOnboardingPrompt(request);
      expect(prompt).toContain(expected);
      if (excludesNotebook) {
        expect(prompt).toContain("Do not create a notebook");
      } else {
        expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
      }
    },
  );

  it.each([
    "Compare sales and stock in a reorder dashboard",
    "Plot inspection errors under different lighting conditions",
    "Create a data visualization from this CSV",
    "Analyze the statistics from an experiment",
    "Benchmark number theory algorithms",
  ])("keeps the output choice open for %s", (request) => {
    const prompt = buildCodexOnboardingPrompt(request);
    expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).toContain(
      "Finish with the useful result in the conversation",
    );
    expect(prompt).toContain(
      "Offer source files and underlying tools as optional next steps",
    );
    expect(prompt).toContain("Actually run or otherwise validate");
  });

  it("uses software guidance when Python and pandas are requested", () => {
    const prompt = buildCodexOnboardingPrompt(
      "Use Python and pandas to compare our results",
    );
    expect(prompt).toContain("appropriate source files");
    expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).toContain(
      "Finish with the useful result in the conversation",
    );
  });

  it.each([
    "Create a Jupyter notebook to analyze sales",
    "Help me create notebooks comparing different models",
    "Use JupyterLab to explore the measurements",
    "Update results.ipynb with this comparison",
    "Jupyter is not only allowed but required",
    "Not only a notebook; also export a PDF",
    "A notebook cannot be avoided for this assignment",
    "I cannot recommend Jupyter highly enough",
  ])("retains notebook guidance when requested: %s", (request) => {
    const prompt = buildCodexOnboardingPrompt(request);
    expect(prompt).toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).toContain(
      "The user's requested output and constraints take priority",
    );
  });

  it.each([
    "Analyze this CSV without a notebook",
    "Do not use Jupyter; give me an HTML report",
    "Don't create a notebook; return a chart in chat",
    "Do not use results.ipynb for this report",
    "I can't use Jupyter for this analysis",
    "Jupyter is not allowed for this project",
    "A notebook should not be used here",
    "JupyterLab is unavailable in this environment",
    "Notebooks are prohibited for this deliverable",
    "Make a report, not a notebook",
    "I am not using Jupyter for this task",
  ])("respects a request to avoid notebooks: %s", (request) => {
    const prompt = buildCodexOnboardingPrompt(request);
    expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).toContain(
      "The user's requested output and constraints take priority",
    );
  });

  it("points Codex at the starter artifact for contextual onboarding", () => {
    const prompt = buildCodexOnboardingPrompt("Add a chart of the results", {
      kind: "jupyter-python",
      artifact: "/home/user/Welcome.ipynb",
    });
    expect(prompt).toContain("/home/user/Welcome.ipynb");
    expect(prompt).toContain("opening and improving that artifact");
    expect(prompt).toContain("Only the onboarding artifact named above");
  });

  it("requires both a positive allowance and enabled site funding", () => {
    expect(
      codexAvailableForOnboarding(
        source({
          source: "site-api-key",
          hasSiteApiKey: true,
          siteAiUsageLimitPositive: false,
          siteFundedCodex: { enabled: true },
        }),
      ),
    ).toBe(false);
    expect(
      codexAvailableForOnboarding(
        source({
          source: "site-api-key",
          hasSiteApiKey: true,
          siteAiUsageLimitPositive: true,
          siteFundedCodex: { enabled: true },
        }),
      ),
    ).toBe(true);
  });

  it("allows connected personal sources without site funding", () => {
    expect(
      codexAvailableForOnboarding(
        source({ source: "subscription", hasSubscription: true }),
      ),
    ).toBe(true);
    expect(
      codexAvailableForOnboarding(
        source({ source: "account-api-key", hasAccountApiKey: true }),
      ),
    ).toBe(true);
  });

  it("makes the absence of per-prompt CoCalc charges explicit", () => {
    expect(
      codexOnboardingFundingDescription(
        source({ source: "subscription", hasSubscription: true }),
      ),
    ).toContain("will not charge you per prompt");
    expect(
      codexOnboardingFundingDescription(
        source({ source: "site-api-key", hasSiteApiKey: true }),
      ),
    ).toContain("no per-prompt CoCalc charges");
  });
});
