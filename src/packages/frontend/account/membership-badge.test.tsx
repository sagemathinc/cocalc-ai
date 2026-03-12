import { act, render, screen, waitFor } from "@testing-library/react";
import MembershipBadge from "./membership-badge";

const api = jest.fn();

let accountId = "account-1";

jest.mock("antd", () => {
  const Button = ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
  const Div = ({ children }: any) => <div>{children}</div>;
  return {
    Button,
    Modal: Div,
    Space: Div,
    Spin: () => <div>spin</div>,
    Tag: Div,
    Typography: {
      Text: Div,
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
    useTypedRedux: () => accountId,
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("./membership-status", () => ({
  MembershipStatusPanel: () => null,
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
      firstMembership.resolve({ class: "pro" });
      firstTiers.resolve([{ id: "pro", label: "Pro" }]);
      await Promise.all([firstMembership.promise, firstTiers.promise]);
    });

    await waitFor(() => {
      expect(screen.getByText("Pro")).toBeTruthy();
    });

    accountId = "account-2";
    rerender(<MembershipBadge />);

    await waitFor(() => {
      expect(screen.queryByText("Pro")).toBeNull();
      expect(screen.getByText("Loading...")).toBeTruthy();
    });

    await act(async () => {
      secondMembership.resolve({ class: "free" });
      secondTiers.resolve([{ id: "free", label: "Free" }]);
      await Promise.all([secondMembership.promise, secondTiers.promise]);
    });

    await waitFor(() => {
      expect(screen.getByText("Free")).toBeTruthy();
    });
  });
});
