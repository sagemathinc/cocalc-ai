import { EventEmitter } from "events";
import { render, screen, waitFor } from "@testing-library/react";
import useListing from "./use-listing";
import { listingsClient } from "@cocalc/conat/service/listings";

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ project_id: "project-1" }),
}));

jest.mock("@cocalc/conat/service/listings", () => ({
  listingsClient: jest.fn(),
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("watches the initial and updated path", async () => {
    const client = new FakeListingsClient();
    client.set("alpha", { files: ["a.txt"] });
    client.set("beta", { files: ["b.txt"] });
    listingsClientMock.mockResolvedValue(client);

    const { rerender } = render(<TestComponent path="alpha" />);

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
