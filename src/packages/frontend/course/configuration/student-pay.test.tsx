/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import StudentPay from "./student-pay";

const getMembershipTiersMock = jest.fn();
const getClaimableMembershipPackagesMock = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store: string, key: string) =>
    key === "email_address" ? "teacher@oes.edu" : { get: () => true },
}));

jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: (...args: any[]) => getMembershipTiersMock(...args),
}));

jest.mock("@cocalc/frontend/purchases/api", () => ({
  getClaimableMembershipPackages: (...args: any[]) =>
    getClaimableMembershipPackagesMock(...args),
}));

jest.mock("@cocalc/frontend/account/membership-tier-benefits", () => ({
  MembershipTierBenefits: ({ tier }: { tier: { label?: string } }) => (
    <div>{tier?.label} benefits</div>
  ),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
}));

jest.mock("@cocalc/frontend/components/error", () => () => null);
jest.mock("@cocalc/frontend/docs/navigation", () => ({
  openProjectDocs: jest.fn(),
}));
jest.mock("./institute-pay", () => ({
  InstitutePaySection: () => null,
}));

describe("StudentPay", () => {
  beforeEach(() => {
    getMembershipTiersMock.mockResolvedValue({
      tiers: [
        {
          id: "student",
          label: "Student",
          priority: 10,
          course_store_visible: true,
          course_price: 18,
          course_duration_days: 122,
          course_grace_days: 14,
        },
      ],
    });
    getClaimableMembershipPackagesMock.mockResolvedValue([
      {
        package_id: "student-pool",
        kind: "site",
        membership_class: "student",
        pool_name: "Students",
        organization_name: "Oregon Episcopal School",
        site_license_name: "OES Adoption Pilot",
        matched_email_address: "teacher@oes.edu",
        requires_approval: false,
        expires_at: new Date("2027-07-01T00:00:00.000Z"),
      },
    ]);
  });

  it("opts the course into compute budgets and links to the budget", async () => {
    const setComputeBudgetEnabled = jest.fn();
    const openComputeBudget = jest.fn();
    const values = new Map<string, unknown>([
      ["compute_budget_enabled", true],
      ["required_membership_class", "student"],
      ["student_pay", true],
      ["institute_pay", false],
      ["site_license_pay", false],
    ]);
    const user = userEvent.setup();
    render(
      <IntlProvider locale="en">
        <StudentPay
          actions={{
            configuration: {
              configure_all_projects: jest.fn(),
              set_compute_budget_enabled: setComputeBudgetEnabled,
              set_course_membership: jest.fn(),
              set_pay_choice: jest.fn(),
            },
          }}
          settings={{ get: (key: string) => values.get(key) }}
          project_id="course-project"
          onManageSeats={jest.fn()}
          onOpenComputeBudget={openComputeBudget}
        />
      </IntlProvider>,
    );

    const checkbox = await screen.findByRole("checkbox", {
      name: "Enable compute budget for this course",
    });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(setComputeBudgetEnabled).toHaveBeenCalledWith(false);
    await user.click(
      screen.getByRole("button", { name: "Open compute budget" }),
    );
    expect(openComputeBudget).toHaveBeenCalledTimes(1);
  });

  it("shows site-license benefits instead of retail course-seat terms", async () => {
    const values = new Map<string, unknown>([
      ["required_membership_class", "student"],
      ["site_license_pay", true],
      ["student_pay", false],
      ["institute_pay", false],
      ["student_membership_grace_days", 14],
    ]);
    render(
      <IntlProvider locale="en">
        <StudentPay
          actions={{
            configuration: {
              configure_all_projects: jest.fn(),
              set_course_membership: jest.fn(),
              set_pay_choice: jest.fn(),
            },
          }}
          settings={{ get: (key: string) => values.get(key) }}
          project_id="course-project"
          onManageSeats={jest.fn()}
        />
      </IntlProvider>,
    );

    const covered = await screen.findByText(
      "Students are covered by the site license",
    );
    expect(
      screen.getByRole("combobox", {
        name: "Site license student membership",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Student benefits")).toBeInTheDocument();
    expect(screen.queryByText(/122 days/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$18/)).not.toBeInTheDocument();

    const whoPays = screen.getByText("Who pays?");
    expect(
      whoPays.compareDocumentPosition(covered) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("selects a default retail tier after choosing who pays", async () => {
    const setCourseMembership = jest.fn();
    const setPayChoice = jest.fn();
    const values = new Map<string, unknown>([
      ["required_membership_class", ""],
      ["site_license_pay", false],
      ["student_pay", false],
      ["institute_pay", false],
    ]);
    render(
      <IntlProvider locale="en">
        <StudentPay
          actions={{
            configuration: {
              configure_all_projects: jest.fn(),
              set_course_membership: setCourseMembership,
              set_pay_choice: setPayChoice,
            },
          }}
          settings={{ get: (key: string) => values.get(key) }}
          project_id="course-project"
          onManageSeats={jest.fn()}
        />
      </IntlProvider>,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: "Student pays directly" }),
    );
    expect(setCourseMembership).toHaveBeenCalledWith(
      expect.objectContaining({ required_membership_class: "student" }),
    );
    expect(setPayChoice).toHaveBeenCalledWith("student", true);
  });
});
