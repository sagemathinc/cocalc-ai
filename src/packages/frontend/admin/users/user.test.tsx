import { fireEvent, render, screen } from "@testing-library/react";
import { UserResult } from "./user";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: () => <span>time-ago</span>,
  CopyToClipBoard: ({ value }: any) => <span>{value}</span>,
}));

jest.mock("antd", () => {
  const Card = ({ title, children }: any) => (
    <div>
      <div>{title}</div>
      <div>{children}</div>
    </div>
  );
  const Space = ({ children }: any) => <div>{children}</div>;
  const Tag: any = ({ children }: any) => <span>{children}</span>;
  const CheckableTag = ({ children, onChange, checked }: any) => (
    <button
      type="button"
      data-checked={checked ? "1" : "0"}
      onClick={() => onChange?.(!checked)}
    >
      {children}
    </button>
  );
  Tag.CheckableTag = CheckableTag;
  return {
    Card,
    Space,
    Tag,
  };
});

jest.mock("./projects", () => ({
  Projects: () => null,
}));

jest.mock("./impersonate", () => ({
  Impersonate: () => null,
}));

jest.mock("./password-reset", () => ({
  PasswordReset: () => null,
}));

jest.mock("./admin-role", () => ({
  AdminRole: ({ is_admin }: any) => (
    <div>{is_admin ? "admin-role-current" : "admin-role-grant"}</div>
  ),
}));

jest.mock("./ban", () => ({
  Ban: () => null,
}));

jest.mock("@cocalc/frontend/purchases/purchases", () => ({
  PurchasesButton: () => null,
}));
jest.mock("@cocalc/frontend/purchases/payments", () => ({
  PaymentsButton: () => null,
}));
jest.mock("./create-payment", () => ({
  CreatePaymentButton: () => null,
}));
jest.mock("../admin-purchase", () => ({
  AdminBalanceAdjustmentButton: () => null,
}));
jest.mock("./money", () => () => null);
jest.mock("./admin-membership", () => ({
  AdminMembership: () => null,
}));

jest.mock("@cocalc/frontend/purchases/managed-egress-history", () => ({
  ManagedEgressHistoryButton: ({ buttonText, user_account_id }: any) => (
    <button>{`${buttonText}:${user_account_id}`}</button>
  ),
  ManagedEgressRateSummary: ({ user_account_id }: any) => (
    <div>{`recent-egress-summary:${user_account_id}`}</div>
  ),
  ManagedEgressTopProjectsSummary: ({ user_account_id }: any) => (
    <div>{`top-projects-summary:${user_account_id}`}</div>
  ),
}));

describe("UserResult egress entry points", () => {
  it("shows direct egress history and expandable egress details", () => {
    render(
      <UserResult
        first_name="Ada"
        last_name="Lovelace"
        email_address="ada@example.com"
        created={"2026-04-27T00:00:00.000Z" as any}
        last_active={"2026-04-28T00:00:00.000Z" as any}
        account_id="acct-1"
        banned={false}
      />,
    );

    expect(screen.getByText("Egress history:acct-1")).toBeTruthy();

    fireEvent.click(screen.getByText(/Ada Lovelace/));
    expect(screen.getByText("Profile")).toBeTruthy();
    fireEvent.click(screen.getByText("Egress"));

    expect(screen.getByText("recent-egress-summary:acct-1")).toBeTruthy();
    expect(screen.getByText("top-projects-summary:acct-1")).toBeTruthy();
    expect(screen.getByText("View egress history:acct-1")).toBeTruthy();
  });

  it("shows account status tags in the collapsed user header", () => {
    render(
      <UserResult
        first_name="Ada"
        last_name="Lovelace"
        email_address="ada@example.com"
        created={"2026-04-27T00:00:00.000Z" as any}
        last_active={"2026-04-28T00:00:00.000Z" as any}
        account_id="acct-1"
        banned={true}
        membership_class="student-ucla-summer-2026"
        membership_label="UCLA Student"
        membership_source="grant"
      />,
    );

    expect(screen.getByText("Banned")).toBeTruthy();
    expect(screen.getByText("UCLA Student")).toBeTruthy();
  });

  it("shows admin status in the collapsed user header and profile card", () => {
    render(
      <UserResult
        first_name="Grace"
        last_name="Hopper"
        email_address="grace@example.com"
        account_id="acct-2"
        banned={false}
        is_admin={true}
      />,
    );

    expect(screen.getByText("ADMIN")).toBeTruthy();

    fireEvent.click(screen.getByText(/Grace Hopper/));
    fireEvent.click(screen.getByText("Profile"));
    expect(screen.getByText("admin-role-current")).toBeTruthy();
  });
});
