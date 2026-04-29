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
  const CheckableTag = ({ children, onChange, checked }: any) => (
    <button
      type="button"
      data-checked={checked ? "1" : "0"}
      onClick={() => onChange?.(!checked)}
    >
      {children}
    </button>
  );
  return {
    Card,
    Space,
    Tag: { CheckableTag },
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

jest.mock("./ban", () => ({
  Ban: () => null,
}));

jest.mock(
  "@cocalc/frontend/frame-editors/crm-editor/users/pay-as-you-go-min-balance",
  () => () => null,
);
jest.mock("@cocalc/frontend/purchases/purchases", () => ({
  PurchasesButton: () => null,
}));
jest.mock("@cocalc/frontend/purchases/payments", () => ({
  PaymentsButton: () => null,
}));
jest.mock("./create-payment", () => ({
  CreatePaymentButton: () => null,
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
    fireEvent.click(screen.getByText("Egress"));

    expect(screen.getByText("recent-egress-summary:acct-1")).toBeTruthy();
    expect(screen.getByText("top-projects-summary:acct-1")).toBeTruthy();
    expect(screen.getByText("View egress history:acct-1")).toBeTruthy();
  });
});
