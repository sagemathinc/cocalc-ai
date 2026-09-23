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
    const prompt = buildCodexOnboardingPrompt(request, { kind: "codex" });
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
    expect(prompt).toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).toContain("Only the onboarding artifact named above");
  });

  it.each(["jupyter-python", "jupyter-r", "jupyter-julia", "sage"])(
    "retains the selected %s notebook path for a generic first request",
    (kind) => {
      const prompt = buildCodexOnboardingPrompt("Summarize these results", {
        kind,
        artifact: "/home/user/Welcome.ipynb",
      });
      expect(prompt).toContain("Prefer a runnable Jupyter notebook");
      expect(prompt).toContain("opening and improving that artifact");
    },
  );

  it("retains a trusted notebook starter when the path kind is omitted", () => {
    const prompt = buildCodexOnboardingPrompt("Summarize these results", {
      artifact: "Welcome.ipynb",
    });
    expect(prompt).toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).toContain("/home/user/Welcome.ipynb");
  });

  it("keeps a selected notebook path when starter-file creation failed", () => {
    const prompt = buildCodexOnboardingPrompt("Summarize these results", {
      kind: "jupyter-r",
    });
    expect(prompt).toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).toContain("project was just created");
  });

  it("keeps a selected notebook for analysis with a named language or library", () => {
    const prompt = buildCodexOnboardingPrompt(
      "Use Python and pandas to compare the results",
      { kind: "jupyter-python", artifact: "/home/user/Welcome.ipynb" },
    );
    expect(prompt).toContain("Prefer a runnable Jupyter notebook");
  });

  it.each([
    "Use an API to analyze these results",
    "Use this script to summarize the data",
  ])("treats the tool in %s as input, not requested software", (request) => {
    const prompt = buildCodexOnboardingPrompt(request, {
      kind: "jupyter-python",
      artifact: "/home/user/Welcome.ipynb",
    });
    expect(prompt).toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).not.toContain("Create the appropriate source files");
  });

  it.each([
    "Build a TypeScript app",
    "Build me a simple interactive TypeScript app",
    "Create a website",
    "Create for me a website",
    "Write a Python script",
    "Use Python to build an app",
    "Use React to create a website",
    "Use Jupyter notebooks to build an app",
    "Help me build a website",
    "Could you help me write a Python script",
    "I would like to create an app",
    "We need to build an API",
    "I need an app",
    "Analyze Jupyter notebooks and build an app",
  ])("lets a concrete %s request override a notebook starter", (request) => {
    const prompt = buildCodexOnboardingPrompt(request, {
      kind: "jupyter-python",
      artifact: "/home/user/Welcome.ipynb",
    });
    expect(prompt).toContain("appropriate source files");
    expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
  });

  it.each([
    "Do not build an app; summarize the data instead",
    "I do not want to create a website; analyze the results",
    "Explain how to build a website",
    "Create a guide to an API",
    "Make notes on a library",
    "Create a comparison of software packages",
    "Create an API reference",
    "Create a software architecture plan",
    "Create a software requirements document",
    "Create a report comparing software packages",
  ])("does not treat %s as a software deliverable", (request) => {
    const prompt = buildCodexOnboardingPrompt(request, {
      kind: "jupyter-python",
      artifact: "/home/user/Welcome.ipynb",
    });
    expect(prompt).not.toContain("Create the appropriate source files");
  });

  it.each([
    "Create a guide to an API",
    "Create a software architecture plan",
    "Create a report comparing software packages",
  ])("does not force a notebook for a requested %s output", (request) => {
    const prompt = buildCodexOnboardingPrompt(request, {
      kind: "jupyter-python",
      artifact: "/home/user/Welcome.ipynb",
    });
    expect(prompt).toContain("Choose the format that best fits");
    expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
  });

  it("uses the first direct output when a software task mentions notebooks", () => {
    const prompt = buildCodexOnboardingPrompt(
      "Build an app to analyze Jupyter notebooks",
      { kind: "jupyter-python", artifact: "/home/user/Welcome.ipynb" },
    );
    expect(prompt).toContain("appropriate source files");
    expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
  });

  it("honors an explicit notebook prohibition even on a notebook path", () => {
    const prompt = buildCodexOnboardingPrompt(
      "Do not use a notebook; return an HTML report",
      { kind: "jupyter-python", artifact: "/home/user/Welcome.ipynb" },
    );
    expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
    expect(prompt).toContain(
      "The user's requested output and constraints take priority",
    );
  });

  it("keeps an explicit LaTeX request above a notebook starter", () => {
    const prompt = buildCodexOnboardingPrompt("Write a LaTeX paper", {
      kind: "jupyter-python",
      artifact: "/home/user/Welcome.ipynb",
    });
    expect(prompt).toContain("compile-ready LaTeX");
    expect(prompt).not.toContain("Prefer a runnable Jupyter notebook");
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
