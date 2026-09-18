/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// One customer-facing source for the AI page, discovery and initial HTML.
// Project briefs describe work to build; they are not packaged industry apps.
const PROJECT_BRIEFS = [
  {
    title: "Plan cash flow before a shortfall",
    description:
      "Build a dashboard from invoices and planned costs. Compare payment-delay scenarios, identify the weeks needing attention and keep the assumptions beside the figures.",
    link: {
      href: "/docs/research/private-dashboard",
      label: "Start with a dashboard guide",
    },
  },
  {
    title: "Compare engineering options",
    description:
      "Turn a calculation into a design comparison. Show which options meet your stated limits, test increased demand and keep failed cases visible for review.",
    link: {
      href: "/docs/research/parallel-cpu",
      label: "Run a parameter comparison",
    },
  },
  {
    title: "Investigate portfolio risk",
    description:
      "Create a research view of positions, concentration, drawdowns and specified stress scenarios. Keep data dates, allocation rules and assumptions visible in the review.",
    link: {
      href: "/docs/research/reproduce-analysis",
      label: "Make an analysis reproducible",
    },
  },
];

export function getPublicAIContent(product?: string) {
  const plus = product === "plus";
  return {
    hero: {
      eyebrow: "AI for work you can inspect",
      title: "Turn a question into work you can use.",
      description: plus
        ? "Build dashboards, compare scenarios and investigate data in a single project on your own machine. Keep the inputs, code and results together so you can check the work and return to it."
        : "Build business dashboards, compare scenarios and investigate data with AI. Keep the inputs, code and results together so you can check the work, refine it and invite others to help.",
    },
    projects: {
      title: "Projects to build, inspect and improve.",
      description:
        "Start with your data and model; add the tools your workflow needs.",
      cards: PROJECT_BRIEFS.map((card) => ({
        ...card,
        link: plus
          ? { href: "/features/python", label: "Explore Python tools" }
          : card.link,
      })),
      guideNote: plus
        ? "Use the software and computing resources available on your machine."
        : "The linked guides cover the underlying workflows. Adapt and validate the analysis for your own decision.",
    },
    workflow: {
      title: "From a question to a result you can review.",
      steps: [
        {
          title: "Define the decision",
          description:
            "Provide the relevant files and explain the result you need, including the checks that matter.",
        },
        {
          title: "Work with the agent",
          description:
            "Use integrated Codex chat or a compatible terminal agent to develop and run the work.",
        },
        {
          title: "Inspect and improve",
          description:
            "Open the results, review changes and test your assumptions before relying on the output.",
        },
      ],
    },
    review: {
      title: "Keep the reasoning with the result.",
      description: plus
        ? "Keep your source files, saved outputs and conversation together for the next iteration. Inspect Codex activity and diffs in its thread, and use the file history available for the editor."
        : "Your source files, saved outputs and conversation remain available for review and the next iteration. Review Codex activity and diffs in its project thread; use TimeTravel for supported collaborative file history.",
      link: {
        href: "/features/compare",
        label: "Compare ways to work with AI",
      },
    },
    setup: {
      title: "Choose how to work with AI.",
      description:
        "Integrated Codex chat works with project files, commands and live notebooks. Compatible terminal agents use their own setup and credentials. Connect the AI access your chosen workflow requires.",
      links: plus
        ? [{ href: "/features/terminal", label: "Explore terminal workflows" }]
        : [
            { href: "/docs/ai/codex-chat", label: "Read the Codex guide" },
            { href: "/features/terminal", label: "Explore terminal workflows" },
          ],
    },
    compute: {
      links: [
        ...(["launchpad", "rocket"].includes(product ?? "")
          ? [
              {
                href: "/features/research-compute",
                label: "Plan research compute",
              },
            ]
          : []),
        { href: "/products", label: "Compare ways to run CoCalc" },
        ...(!plus ? [{ href: "/pricing", label: "Explore plans" }] : []),
      ],
      title: plus
        ? "Work with the resources on your machine."
        : "Make room for a larger question.",
      description: plus
        ? "CoCalc Plus runs one local project. Compare other CoCalc editions when you need a different hosting or collaboration model."
        : "Compare available compute options when your model needs more memory or processing capacity. Hosts and remote notebook kernels have different setup requirements; availability depends on your account and deployment.",
    },
    closing: {
      title: plus
        ? "Get to know CoCalc Plus."
        : "Start with the decision you need to make.",
      description: plus
        ? "Review the setup for this single-user edition."
        : "Create a project, bring your files and choose an AI workflow. Review the result before putting it to use.",
    },
  };
}

export function getPublicAISections(product?: string) {
  const c = getPublicAIContent(product);
  return [
    {
      title: c.projects.title,
      paragraphs: [c.projects.description, c.projects.guideNote],
    },
    ...c.projects.cards.map((card) => ({
      title: card.title,
      paragraphs: [card.description],
      links: [card.link],
    })),
    { title: c.workflow.title, paragraphs: [] },
    ...c.workflow.steps.map((step) => ({
      title: step.title,
      paragraphs: [step.description],
    })),
    {
      title: c.review.title,
      paragraphs: [c.review.description],
      links: [c.review.link],
    },
    {
      title: c.setup.title,
      paragraphs: [c.setup.description],
      links: c.setup.links,
    },
    {
      title: c.compute.title,
      paragraphs: [c.compute.description],
      links: c.compute.links,
    },
    { title: c.closing.title, paragraphs: [c.closing.description] },
  ];
}
