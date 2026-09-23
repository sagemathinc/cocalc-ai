/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { InstitutePaySection } from "./institute-pay";
import userEvent from "@testing-library/user-event";
import {
  getMembershipPackages,
  linkCourseMembershipPackage,
} from "@cocalc/frontend/purchases/api";

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (action: () => Promise<void>) => await action(),
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  TimeAgo: () => null,
}));

jest.mock("@cocalc/frontend/purchases/api", () => ({
  getMembershipPackageQuote: jest.fn(),
  getMembershipPackages: jest.fn(async () => []),
  linkCourseMembershipPackage: jest.fn(async () => undefined),
  isPurchaseAllowed: jest.fn(),
  processPaymentIntents: jest.fn(),
  purchaseMembershipPackage: jest.fn(),
}));

jest.mock("@cocalc/frontend/purchases/payments", () => () => null);
jest.mock("@cocalc/frontend/purchases/stripe-payment", () => () => null);
jest.mock("@cocalc/frontend/purchases/money-statistic", () => () => null);

describe("InstitutePaySection", () => {
  it("restores focus after each of two package links", async () => {
    const packages = ["pool-a", "pool-b"].map((id) => ({
      id,
      kind: "course",
      membership_class: "student",
      seat_count: 100,
      available_seat_count: 100,
      metadata: { course_project_id: "old-course" },
      assignments: [],
    }));
    (getMembershipPackages as jest.Mock)
      .mockResolvedValueOnce(packages)
      .mockResolvedValueOnce([
        { ...packages[0], metadata: { course_project_id: "new-course" } },
        packages[1],
      ])
      .mockResolvedValueOnce(
        packages.map((pkg) => ({
          ...pkg,
          metadata: { course_project_id: "new-course" },
        })),
      );
    render(
      <InstitutePaySection
        project_id="new-course"
        enabled
        selectedTier={{ id: "student" }}
        onToggle={jest.fn()}
      />,
    );
    for (const pkg of packages) {
      const button = await screen.findByRole("button", {
        name: `Use existing package ${pkg.id}`,
      });
      button.focus();
      await userEvent.keyboard("{Enter}");
      await screen.findByRole("status");
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /refresh seats/i }),
      );
    }
  });
  it("links an existing pool using the keyboard without buying seats", async () => {
    const pkg = {
      id: "pool-1",
      kind: "course",
      membership_class: "student",
      seat_count: 100,
      available_seat_count: 65,
      active_assignment_count: 35,
      metadata: { course_project_id: "old-course" },
      assignments: [],
    };
    (getMembershipPackages as jest.Mock)
      .mockResolvedValueOnce([pkg])
      .mockResolvedValueOnce([
        {
          ...pkg,
          metadata: {
            course_project_ids: ["old-course", "new-course"],
          },
        },
      ]);
    render(
      <InstitutePaySection
        project_id="new-course"
        enabled
        selectedTier={{ id: "student" }}
        onToggle={jest.fn()}
      />,
    );
    const button = await screen.findByRole("button", {
      name: "Use existing package pool-1",
    });
    button.focus();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    expect(linkCourseMembershipPackage).toHaveBeenCalledWith({
      package_id: "pool-1",
      course_project_id: "new-course",
    });
    expect(
      await screen.findByRole("button", { name: /add seats/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Use existing package pool-1" }),
    ).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /refresh seats/i }),
    );
    expect(screen.getByRole("status").textContent).toContain("Package linked");
  });
  it("offers seat management with the other instructor-paid actions", async () => {
    const onManageSeats = jest.fn();
    render(
      <InstitutePaySection
        project_id="project-1"
        enabled
        showToggle={false}
        selectedTier={{ id: "course-tier" }}
        onManageSeats={onManageSeats}
        onToggle={jest.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /manage seats/i }));
    expect(onManageSeats).toHaveBeenCalledTimes(1);
  });
});
