import { EventEmitter } from "events";
import { render, screen, waitFor } from "@testing-library/react";
import useListing from "./use-listing";
import { listingsClient } from "@cocalc/conat/service/listings";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ project_id: PROJECT_ID }),
}));

jest.mock("@cocalc/conat/service/listings", () => ({
  listingsClient: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConat: jest.fn(),
    },
  },
}));

class FakeListingsClient extends EventEmitter {
  private readonly values = new Map<string, any>();

  watch = jest.fn(async (_path: string) => {});
  close = jest.fn();

  get(path: string) {
    return this.values.get(path);
  }

  set(path: string, value: any) {
    this.values.set(path, value);
  }

  setMaxListeners(n: number) {
    super.setMaxListeners(n);
    return this;
  }
}

function TestComponent({ path }: { path: string }) {
  const listing = useListing({ path });
  return <span data-testid="listing">{JSON.stringify(listing ?? null)}</span>;
}

describe("useListing", () => {
  const listingsClientMock = listingsClient as unknown as jest.Mock;
  const projectConatMock = webapp_client.conat_client
    .projectConat as unknown as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    projectConatMock.mockResolvedValue({ sync: {} });
  });

  it("watches the initial and updated path", async () => {
    const client = new FakeListingsClient();
    client.set("alpha", { files: ["a.txt"] });
    client.set("beta", { files: ["b.txt"] });
    listingsClientMock.mockResolvedValue(client);

    const { rerender } = render(<TestComponent path="alpha" />);

    await waitFor(() => {
      expect(projectConatMock).toHaveBeenCalledWith({
        project_id: PROJECT_ID,
        caller: "useListing",
      });
    });
    expect(listingsClientMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      client: { sync: {} },
    });
    await waitFor(() => {
      expect(client.watch).toHaveBeenCalledWith("alpha");
    });
    await waitFor(() => {
      expect(screen.getByTestId("listing").textContent).toContain("a.txt");
    });

    rerender(<TestComponent path="beta" />);

    await waitFor(() => {
      expect(client.watch).toHaveBeenCalledWith("beta");
    });
    await waitFor(() => {
      expect(screen.getByTestId("listing").textContent).toContain("b.txt");
    });
  });
});
