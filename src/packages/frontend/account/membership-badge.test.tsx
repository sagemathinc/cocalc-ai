import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import MembershipBadge from "./membership-badge";

const api = jest.fn();
const openAccountSettings = jest.fn();

let accountId = "account-1";
let stripeEnabled = true;
let hideNavbarMembership = false;

jest.mock("antd", () => {
  const Button = ({ children, onClick, ...props }: any) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={props["aria-label"]}
      style={props.style}
    >
      {children}
    </button>
  );
  return {
    Button,
    ConfigProvider: ({ children }: any) => children,
    theme: {
      useToken: () => ({
        token: {
          colorText: "black",
          fontWeightStrong: 600,
          green2: "green-2",
          green3: "green-3",
          green4: "green-4",
          green6: "green-6",
          marginXXS: 4,
        },
      }),
    },
  };
});

jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: (...args: any[]) => api(...args),
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    useAsyncEffect: (fn: any, deps: any[]) => {
      React.useEffect(() => {
        let mounted = true;
        void fn(() => mounted);
        return () => {
          mounted = false;
        };
      }, deps);
    },
    useTypedRedux: (store: string, field: string) => {
      if (store === "account" && field === "account_id") return accountId;
      if (store === "customize" && field === "stripe_enabled") {
        return stripeEnabled;
      }
      return undefined;
    },
    useAccountOtherSetting: (key: string) =>
      key === "hide_navbar_membership" ? hideNavbarMembership : undefined,
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  Tooltip: ({ children, title }: any) => (
    <>
      {children}
      {title}
    </>
  ),
}));

jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: (...args: any[]) => openAccountSettings(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("MembershipBadge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accountId = "account-1";
    stripeEnabled = true;
    hideNavbarMembership = false;
  });

  it("clears the previous tier label immediately when the account changes", async () => {
    const firstMembership = deferred<any>();
    const firstTiers = deferred<any>();
    const secondMembership = deferred<any>();
    const secondTiers = deferred<any>();
    api
      .mockReturnValueOnce(firstMembership.promise)
      .mockReturnValueOnce(firstTiers.promise)
      .mockReturnValueOnce(secondMembership.promise)
      .mockReturnValueOnce(secondTiers.promise);

    const { rerender } = render(<MembershipBadge />);

    await act(async () => {
      firstMembership.resolve({ class: "pro", source: "subscription" });
      firstTiers.resolve({ tiers: [{ id: "pro", label: "Pro" }] });
      await Promise.all([firstMembership.promise, firstTiers.promise]);
    });

    await waitFor(() => {
      expect(screen.getByText("Pro")).toBeTruthy();
    });

    accountId = "account-2";
    rerender(<MembershipBadge />);

    expect(screen.queryByText("Pro")).toBeNull();

    await act(async () => {
      secondMembership.resolve({ class: "free", source: "free" });
      secondTiers.resolve({ tiers: [{ id: "free", label: "Free" }] });
      await Promise.all([secondMembership.promise, secondTiers.promise]);
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Current membership: Free. View details and change plans.",
        }),
      ).toBeTruthy();
    });
  });

  it("opens membership settings from the current tier button", async () => {
    api
      .mockResolvedValueOnce({ class: "advanced", source: "subscription" })
      .mockResolvedValueOnce({
        tiers: [{ id: "advanced", label: "Advanced Researcher" }],
      });

    render(<MembershipBadge />);

    const button = await screen.findByRole("button", {
      name: "Current membership: Advanced Researcher. View details and change plans.",
    });
    expect(
      screen.getByText("Current membership: Advanced Researcher"),
    ).toBeTruthy();
    expect(screen.getByText("View details and change plans.")).toBeTruthy();
    expect((button as HTMLElement).style.maxWidth).toBe("120px");
    fireEvent.click(button);

    expect(openAccountSettings).toHaveBeenCalledWith({ page: "membership" });
  });

  it("shows the Free tier name instead of an upgrade label", async () => {
    api
      .mockResolvedValueOnce({ class: "free", source: "free" })
      .mockResolvedValueOnce({
        tiers: [{ id: "free", label: "Free" }],
      });

    render(<MembershipBadge />);

    expect(
      await screen.findByRole("button", {
        name: "Current membership: Free. View details and change plans.",
      }),
    ).toHaveTextContent("Free");
    expect(screen.queryByText("Upgrade")).toBeNull();
  });

  it("does not load or show the tier when hidden in account settings", () => {
    hideNavbarMembership = true;

    render(<MembershipBadge />);

    expect(api).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("always shows Free in compact navigation despite the general hide setting", async () => {
    hideNavbarMembership = true;
    api
      .mockResolvedValueOnce({ class: "free", source: "free" })
      .mockResolvedValueOnce({ tiers: [{ id: "free", label: "Free" }] });

    render(<MembershipBadge alwaysShowFree />);

    expect(
      await screen.findByRole("button", {
        name: "Current membership: Free. View details and change plans.",
      }),
    ).toBeTruthy();
  });

  it("still honors the hide setting for paid tiers in compact navigation", async () => {
    hideNavbarMembership = true;
    api
      .mockResolvedValueOnce({ class: "pro", source: "subscription" })
      .mockResolvedValueOnce({ tiers: [{ id: "pro", label: "Pro" }] });

    render(<MembershipBadge alwaysShowFree />);

    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
