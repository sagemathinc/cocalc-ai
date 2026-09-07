/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { ProjectSettingsSectionNav } from "./section-nav";
import { ProjectSettingsSectionCard } from "./section-card";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => <span aria-hidden="true" />,
}));

afterEach(() => document.documentElement.removeAttribute("data-cocalc-theme"));

it.each(["light", "dark"])(
  "keeps settings headings and navigation theme-aware in %s",
  async (mode) => {
    document.documentElement.setAttribute("data-cocalc-theme", mode);
    const user = userEvent.setup();
    render(
      <>
        <ProjectSettingsSectionNav
          items={[
            { id: "overview", icon: "file", label: "Overview" },
            {
              id: "danger",
              icon: "trash",
              label: "Delete project",
              danger: true,
            },
          ]}
        />
        <ProjectSettingsSectionCard
          id="overview"
          icon="file"
          title="Project overview"
        >
          <p>Project identity</p>
        </ProjectSettingsSectionCard>
        <ProjectSettingsSectionCard
          id="danger"
          icon="trash"
          title="Danger zone"
          danger
        >
          <p>Permanent changes</p>
        </ProjectSettingsSectionCard>
      </>,
    );
    expect(
      screen.getByRole("heading", { name: "Project overview" }).style.color,
    ).toBe(UI_COLORS.text);
    expect(
      screen.getByRole("heading", { name: "Danger zone" }).style.color,
    ).toBe(UI_COLORS.danger);
    const overview = screen.getByRole("link", { name: "Overview" });
    const danger = screen.getByRole("link", { name: "Delete project" });
    expect(overview.style.color).toBe(UI_COLORS.text);
    expect(danger.style.color).toBe(UI_COLORS.danger);
    await user.tab();
    expect(overview).toHaveFocus();
    await user.tab();
    expect(danger).toHaveFocus();
    expect(danger).toHaveAttribute("href", "#danger");
  },
);
