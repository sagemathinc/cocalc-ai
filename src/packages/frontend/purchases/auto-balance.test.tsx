import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import AutoBalance from "./auto-balance";

let mockStripeEnabled = false;

jest.mock("antd", () => ({
  Button: ({ children, onClick }: any) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (name: string, field: string) => {
    if (name === "customize" && field === "stripe_enabled") {
      return mockStripeEnabled;
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

describe("AutoBalance", () => {
  beforeEach(() => {
    mockStripeEnabled = false;
  });

  it("hides automatic deposits when Stripe billing is unavailable", () => {
    render(<AutoBalance />);

    expect(screen.queryByText("Enable Automatic Deposits")).toBeNull();
  });

  it("shows automatic deposits when Stripe billing is available", () => {
    mockStripeEnabled = true;

    render(<AutoBalance />);

    expect(screen.getByText("Enable Automatic Deposits")).toBeTruthy();
  });
});
