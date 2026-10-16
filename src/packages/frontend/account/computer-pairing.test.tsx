import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SOLO = "33333333-3333-4333-8333-333333333333";
const SHARED = "44444444-4444-4444-8444-444444444444";

let mockRequest: any = {
  request_id: "R-NEW",
  name: "m1",
  project_id: SOLO,
  state: "pending",
  pairing_phrase: null,
  machine: null,
  expires_at: Date.now() + 3_600_000,
  // The home bay's URL: not this browser's origin.
  pairing_url: "https://bay-2.example.com/c/R-NEW",
};
const mockApi = {
  createComputerRequest: jest.fn(async () => ({
    request_id: "R-NEW",
    expires_at: Date.now() + 3_600_000,
    pairing_url: "https://bay-2.example.com/c/R-NEW",
  })),
  listComputerRequests: jest.fn(async () => [mockRequest]),
  approveComputerRequest: jest.fn(async () => ({ computer_id: "c" })),
};
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: { hub: { computers: mockApi } } },
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (fn: () => unknown) => {
      await fn();
      return true;
    },
    freshAuthModalProps: {},
  }),
}));
const mockProjects = fromJS({
  [SOLO]: { title: "Solo", users: { [ME]: { group: "owner" } } },
  [SHARED]: {
    title: "Shared",
    users: { [ME]: { group: "owner" }, [OTHER]: { group: "collaborator" } },
  },
});
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, key: string) =>
    store === "account" && key === "account_id" ? ME : mockProjects,
}));

import {
  ConnectComputer,
  PairingSteps,
  approvalText,
} from "./computer-pairing";

beforeEach(() => {
  jest.clearAllMocks();
});

test("only projects whose one collaborator is you can have a computer", async () => {
  render(<ConnectComputer />);
  await userEvent.click(screen.getByRole("combobox"));
  expect(screen.getAllByText("Solo").length).toBeGreaterThan(0);
  expect(screen.queryByText("Shared")).toBeNull();
});

test("a request names the computer and its project; the line is the home bay's", async () => {
  render(<ConnectComputer defaultProjectId={SOLO} />);
  await userEvent.type(screen.getByLabelText("Computer name"), "m1");
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(mockApi.createComputerRequest).toHaveBeenCalledWith({
    name: "m1",
    project_id: SOLO,
  });
  await waitFor(() =>
    expect(
      screen.getByText(
        "curl -fsSL 'https://bay-2.example.com/api/v2/cli/setup?action=computer&request=R-NEW' | sh",
      ),
    ).toBeTruthy(),
  );
  expect(
    screen.getByText(
      "cocalc computer connect https://bay-2.example.com/c/R-NEW",
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain(location.origin);
});

test("approval sends the phrase the owner saw, and says what it allows", async () => {
  mockRequest = {
    ...mockRequest,
    state: "claimed",
    pairing_phrase: "acorn-amber-anchor-apple",
    machine: {
      user: "sage",
      hostname: "studio.local",
      os: "darwin",
      arch: "arm64",
    },
  };
  render(<PairingSteps request_id="R-NEW" />);
  await waitFor(() =>
    expect(screen.getByText("acorn-amber-anchor-apple")).toBeTruthy(),
  );
  expect(document.body.textContent).toContain(
    'Anything running in the project "Solo"',
  );
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(mockApi.approveComputerRequest).toHaveBeenCalledWith({
    request_id: "R-NEW",
    pairing_phrase: "acorn-amber-anchor-apple",
  });
});

test("approving says the rule", () => {
  expect(approvalText({ machine: { user: "sage" } } as any, "Solo")).toBe(
    'Anything running in the project "Solo" (agents included) will be able to run any command there as sage, with all of that user\'s access, until you revoke it.',
  );
});
