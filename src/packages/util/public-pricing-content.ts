/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// Shared buying guidance only. Prices and entitlements come from the live catalog.
export function getPublicPricingContent(product?: string) {
  const plus = product === "plus";
  return {
    pageTitle: plus ? "Setup and licensing" : "Plans and pricing",
    description: plus
      ? "Review CoCalc Plus setup and compare shared or hosted CoCalc editions."
      : "Compare CoCalc memberships, additional compute, team seats and organization purchasing options.",
    hero: {
      title: plus
        ? "Choose how you run CoCalc."
        : "Choose a plan for your work.",
      description: plus
        ? "Run one project on your own computer. Explore CoCalc Plus setup, or compare other editions when you need shared access or different hosting."
        : "Choose a membership for the work you do today. Compare more capacity, team access and hosting options as your needs grow.",
    },
    memberships: {
      title: "Hosted memberships",
      description: "Compare current prices, included usage and features.",
      upgrade:
        "Need more room to work? Compare higher project and usage limits. Shared resources are usage allowances, not reserved capacity.",
      billing: "Annual prices are shown per month and billed yearly.",
      ai: "Some memberships on this site include AI usage. Compare the current tier limits below; availability and models depend on this site's configuration.",
    },
    nextTitle: plus ? "Other ways to run CoCalc" : "When your work needs more",
    team: {
      title: "Team seats",
      description:
        "Buy membership seats for colleagues and assign each person their own access. One account manages payment. Sign in to buy or manage seats.",
    },
    organization: {
      title: "Organization licensing and billing",
      description:
        "Bring CoCalc to your organization. Contact us for a quote, customized invoice or purchasing process that does not fit self-service checkout.",
    },
    host: {
      title: "Dedicated project hosts",
      description:
        "Explore a different CPU, memory or GPU configuration for larger jobs. Access depends on your account, available capacity and deployment. Review host pricing and funding before starting.",
    },
    deployment: {
      title: "Run CoCalc on your infrastructure",
      description:
        "Compare CoCalc Plus for one person, CoCalc Star on one VM, and the Launchpad and Rocket deployment paths. Your organization handles infrastructure, recovery and ongoing operations.",
    },
    quote: {
      title: "Quotes and customized invoices",
      description:
        "For a customer-operated product purchase, tell us which edition you need, where it will run and your purchasing requirements.",
    },
  };
}
