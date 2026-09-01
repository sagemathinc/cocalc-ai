import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: () => <span>time-ago</span>,
  CopyToClipBoard: ({ value }: any) => (
    <button type="button" aria-label={`Copy ${value}`}>
      {value}
    </button>
  ),
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
  Projects: ({ account_id }: any) => <div>{`projects:${account_id}`}</div>,
}));

jest.mock("./impersonate", () => ({
  Impersonate: () => null,
}));

jest.mock("./password-reset", () => ({
  PasswordReset: ({ email_address_verified }: any) => (
    <div>
      password-reset-email-status:
      {email_address_verified == null ? "unknown" : `${email_address_verified}`}
    </div>
  ),
}));

jest.mock("./admin-role", () => ({
  AdminRole: ({ is_admin }: any) => (
    <div>{is_admin ? "admin-role-current" : "admin-role-grant"}</div>
  ),
}));

jest.mock("./ban", () => ({
  Ban: () => null,
}));

jest.mock("./billing", () => ({
  AdminBilling: ({ account_id }: any) => (
    <div>{`admin-billing:${account_id}`}</div>
  ),
}));
jest.mock("./admin-membership", () => ({
  AdminMembership: () => null,
}));
jest.mock("./legacy-migration", () => ({
  LegacyMigrationAdmin: () => null,
}));

jest.mock("@cocalc/frontend/purchases/managed-egress-history", () => ({
  ManagedEgressHistoryPanel: ({ user_account_id }: any) => (
    <div>{`egress-history:${user_account_id}`}</div>
  ),
}));

const { UserResult } = require("./user");

describe("UserResult admin tools", () => {
  it("toggles details from the first row without toggling copy controls", () => {
    render(
      <UserResult
        first_name="Ada"
        last_name="Lovelace"
        email_address="ada@example.com"
        account_id="acct-1"
        banned={false}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy ada@example.com" }),
    );
    expect(screen.queryByText("Profile")).toBeNull();

    fireEvent.click(screen.getByText(/Ada Lovelace/));
    expect(screen.getByText("Profile")).toBeTruthy();

    fireEvent.click(screen.getByText(/Ada Lovelace/));
    expect(screen.queryByText("Profile")).toBeNull();
  });

  it("shows egress history directly in the Egress tool", () => {
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

    expect(screen.queryByText("egress-history:acct-1")).toBeNull();

    fireEvent.click(screen.getByText(/Ada Lovelace/));
    expect(screen.getByText("Profile")).toBeTruthy();
    fireEvent.click(screen.getByText("Egress"));

    expect(screen.getByText("egress-history:acct-1")).toBeTruthy();
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

    fireEvent.click(screen.getByText(/Ada Lovelace/));
    expect(screen.getAllByText("Banned")).toHaveLength(1);
    expect(screen.getAllByText("UCLA Student")).toHaveLength(1);
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

  it("passes email verification status to profile actions", () => {
    render(
      <UserResult
        first_name="Ada"
        last_name="Lovelace"
        email_address="ada@example.com"
        email_address_verified={true}
        account_id="acct-1"
        banned={false}
      />,
    );

    fireEvent.click(screen.getByText(/Ada Lovelace/));
    fireEvent.click(screen.getByText("Profile"));

    expect(screen.getByText("password-reset-email-status:true")).toBeTruthy();
  });

  it("opens at most one expandable admin section", () => {
    render(
      <UserResult
        first_name="Ada"
        last_name="Lovelace"
        email_address="ada@example.com"
        account_id="acct-1"
        banned={false}
      />,
    );

    fireEvent.click(screen.getByText(/Ada Lovelace/));
    fireEvent.click(screen.getByText("Profile"));
    expect(
      screen.getByText("password-reset-email-status:unknown"),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Egress"));
    expect(
      screen.queryByText("password-reset-email-status:unknown"),
    ).toBeNull();
    expect(screen.getByText("egress-history:acct-1")).toBeTruthy();

    fireEvent.click(screen.getByText("Egress"));
    expect(screen.queryByText("egress-history:acct-1")).toBeNull();
  });

  it("opens the user billing section", () => {
    render(
      <UserResult
        first_name="Ada"
        last_name="Lovelace"
        email_address="ada@example.com"
        account_id="acct-1"
        banned={false}
      />,
    );

    fireEvent.click(screen.getByText(/Ada Lovelace/));
    fireEvent.click(screen.getByText("Billing"));

    expect(screen.getByText("admin-billing:acct-1")).toBeTruthy();
    expect(screen.getAllByText("Billing")).toHaveLength(1);
  });

  it("can open expanded with a selected admin section", () => {
    render(
      <UserResult
        first_name="Ada"
        last_name="Lovelace"
        email_address="ada@example.com"
        account_id="acct-1"
        banned={false}
        defaultExpanded
        defaultSection="projects"
      />,
    );

    expect(screen.getByText("projects:acct-1")).toBeTruthy();
    expect(screen.getByText("Projects")).toHaveAttribute("data-checked", "1");
  });
});
