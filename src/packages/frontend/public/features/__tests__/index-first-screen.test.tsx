/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  getPublicFeaturesIntro,
  getPublicFeaturesTasks,
  PUBLIC_FEATURES_EYEBROW,
  PUBLIC_FEATURES_HEADLINE,
} from "@cocalc/util/public-features-index";
import PublicFeaturesApp from "../app";

describe("PublicFeaturesApp index first screen", () => {
  // The crawler fallback renders the same records; its HTML is checked in
  // hub/servers/app/public-prerender.test.ts.
  const cocalcAi = {
    cocalc_product: "launchpad",
    dns: "cocalc.ai",
    is_launchpad: true,
    site_name: "CoCalc",
  };
  const allTasks = [
    "Work with agents",
    "Run project software",
    "Choose compute",
    "Automate with the CoCalc CLI",
  ];

  it.each([
    ["cocalc.ai", cocalcAi, "Start on CoCalc.ai", 4],
    ["cocalc.ai signed in", { ...cocalcAi, is_authenticated: true }, "", 4],
    [
      "a Rocket site",
      { cocalc_product: "rocket", dns: "cocalc.example.edu" },
      "Create account",
      4,
    ],
    [
      "a customer-operated Launchpad site",
      {
        cocalc_product: "launchpad",
        dns: "lp.example.org",
        site_name: "CoCalc Launchpad",
      },
      "Create account",
      4,
    ],
    ["CoCalc Plus", { cocalc_product: "plus" }, "", 1],
  ])(
    "renders the index first screen from its shared record on %s",
    (site, config, signUp, taskCount) => {
      render(
        <PublicFeaturesApp config={config} initialRoute={{ view: "index" }} />,
      );
      expect(screen.getByText(PUBLIC_FEATURES_EYEBROW)).not.toBeNull();
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: PUBLIC_FEATURES_HEADLINE,
        }),
      ).not.toBeNull();
      expect(screen.getByText(getPublicFeaturesIntro(config))).not.toBeNull();
      const tasks = getPublicFeaturesTasks(config);
      expect(tasks.map(({ title }) => title)).toEqual(
        allTasks.slice(0, taskCount),
      );
      for (const { body, href, title } of tasks) {
        const card = screen
          .getByRole("heading", { level: 2, name: title })
          .closest("a")!;
        expect(card.getAttribute("href")).toBe(href);
        expect(card.textContent).toBe(`${title}${body.replace(/`/g, "")}`);
      }
      expect(tasks[0].body.includes("Claude Code")).toBe(
        site.startsWith("cocalc.ai"),
      );
      for (const label of ["Start on CoCalc.ai", "Create account"]) {
        expect(screen.queryByRole("link", { name: label }) != null).toBe(
          label === signUp,
        );
      }
      if (signUp) {
        expect(screen.getByRole("link", { name: signUp })).toHaveAttribute(
          "href",
          "/auth/sign-up",
        );
      }
      expect(
        screen.getByRole("link", { name: "Explore AI agents" }),
      ).toHaveAttribute("href", "/features/ai");
    },
  );

  it("reaches each first-screen link by keyboard and opens it with Enter", async () => {
    const user = userEvent.setup();
    render(
      <PublicFeaturesApp config={cocalcAi} initialRoute={{ view: "index" }} />,
    );
    const links = ["Start on CoCalc.ai", "Explore AI agents", ...allTasks].map(
      (name) => screen.getByRole("link", { name: new RegExp(`^${name}`) }),
    );
    const opened: EventTarget[] = [];
    const open = (event: Event) => {
      event.preventDefault();
      if (event.target) opened.push(event.target);
    };
    document.addEventListener("click", open);
    try {
      for (let i = 0; i < 50 && document.activeElement !== links[0]; i++) {
        await user.tab();
      }
      for (const [index, link] of links.entries()) {
        if (index > 0) await user.tab();
        expect(link).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(opened.at(-1)).toBe(link);
      }
    } finally {
      document.removeEventListener("click", open);
    }
  });
});
