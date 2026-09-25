import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Modal } from "antd";
import type { ApiKey } from "@cocalc/util/db-schema/api-keys";
import ApiKeys from "./api-keys";

afterEach(() => Modal.destroyAll());

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => null,
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (action: () => Promise<void>) => {
      await action();
      return true;
    },
    freshAuthModalProps: {},
  }),
}));
jest.mock("@cocalc/frontend/docs/link", () => ({
  DocsLink: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@cocalc/frontend/i18n/components", () => ({
  CancelText: () => <>Cancel</>,
}));
jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: () => <div />,
}));
jest.mock("./copy-to-clipboard", () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => <div>{value}</div>,
}));

test("manual key creation submits the shared scope and shows its secret", async () => {
  const manage = jest.fn(async ({ action }: { action: string }) => {
    if (action === "get") return [] as ApiKey[];
    return [{ id: 7, secret: "synthetic-test-secret" } as ApiKey];
  });
  render(<ApiKeys manage={manage} />);
  fireEvent.click(await screen.findByRole("button", { name: /Add API key/ }));
  const dialog = screen.getByRole("dialog", { name: "Create a New API Key" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
    target: { value: "List only" },
  });
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "List my projects" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(manage).toHaveBeenCalledWith({
      action: "create",
      name: "List only",
      expire: null,
      scope: { version: 1, account: ["project:list"], projects: [] },
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("synthetic-test-secret")).toBeVisible(),
  );
});

test("editing a mixed key preserves separate project grants", async () => {
  const originalScope = {
    version: 1 as const,
    account: ["project:list" as const],
    projects: [
      {
        project_id: "22222222-2222-4222-8222-222222222222",
        capabilities: ["project:exec" as const],
      },
      {
        project_id: "33333333-3333-4333-8333-333333333333",
        capabilities: ["file:read" as const, "project:read" as const],
        viewer_read_roots: ["docs"],
      },
    ],
  };
  const key = {
    id: 8,
    name: "Mixed key",
    trunc: "sk-cc...12345678",
    capabilities: [],
    allowed_project_ids: [],
    scope: originalScope,
  } as ApiKey;
  const manage = jest.fn(async ({ action }: { action: string }) =>
    action === "get" ? [key] : undefined,
  );
  render(<ApiKeys manage={manage} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit API Key" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(manage).toHaveBeenCalledWith({
      action: "edit",
      id: 8,
      name: "Mixed key",
      expire: null,
      scope: originalScope,
    }),
  );
});
