import { render, screen, within } from "@testing-library/react";

import { CourseMembershipBanner } from "./course-membership-banner";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { hub: { projects: { getCourseStudentAccess: jest.fn() } } },
  },
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: ({ date }) => <time dateTime={date}>{date}</time>,
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({}));
jest.mock("@cocalc/frontend/components/error", () => () => null);
jest.mock("@cocalc/frontend/purchases/money-statistic", () => () => null);
jest.mock("@cocalc/frontend/purchases/payments", () => () => null);
jest.mock("@cocalc/frontend/purchases/stripe-payment", () => () => null);
jest.mock("@cocalc/frontend/purchases/api", () => ({}));

const getAccess = jest.mocked(
  webapp_client.conat_client.hub.projects.getCourseStudentAccess,
);
const deadline = "2026-10-13T07:00:00.000Z";

beforeEach(() => {
  getAccess.mockReset();
});

test("grace alert postpones membership without promising paid runtime benefits", async () => {
  getAccess.mockResolvedValue({
    status: "grace",
    deadline,
    required_membership_class: "student",
    required_label: "Student",
    course: { project_id: "00000000-0000-4000-8000-000000000001" },
  });
  render(<CourseMembershipBanner project_id="synthetic-project" />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "The course membership requirement is postponed until",
  );
  expect(alert.textContent).toContain(deadline);
  expect(alert.textContent).toContain(
    "Your current membership's runtime and network limits still apply",
  );
  expect(alert.textContent).not.toMatch(/full access/i);
  expect(
    within(alert).getByRole("button", { name: "Buy course membership" }),
  ).toBeTruthy();
  expect(getAccess).toHaveBeenCalledTimes(1);
});

test("expired grace still reports payment required, not a postponed requirement", async () => {
  getAccess.mockResolvedValue({
    status: "blocked",
    deadline,
    required_membership_class: "student",
  });
  render(<CourseMembershipBanner project_id="synthetic-project" />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "The grace period for this course has ended",
  );
  expect(alert.textContent).not.toContain("postponed");
  expect(
    within(alert).getByRole("button", { name: "Buy course membership" }),
  ).toBeTruthy();
});
