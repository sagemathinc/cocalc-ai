import { render, screen, waitFor } from "@testing-library/react";
import useBackupsListing, { getCachedBackupsListing } from "./use-backups";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          getBackups: jest.fn(),
          getBackupFiles: jest.fn(),
        },
      },
    },
  },
}));

function TestComponent({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}) {
  const { listing } = useBackupsListing({ project_id, path });
  return (
    <span data-testid="listing">{listing?.map((x) => x.name).join(",")}</span>
  );
}

describe("useBackupsListing", () => {
  const getBackupsMock = webapp_client.conat_client.hub.projects
    .getBackups as jest.Mock;
  const getBackupFilesMock = webapp_client.conat_client.hub.projects
    .getBackupFiles as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    getBackupsMock.mockResolvedValue([
      { id: "backup-1", time: "2026-03-12T00:00:00.000Z" },
    ]);
    getBackupFilesMock.mockImplementation(async ({ project_id }) => {
      return project_id === "project-1"
        ? [{ name: "alpha.txt", isDir: false, mtime: 1, size: 10 }]
        : [{ name: "beta.txt", isDir: false, mtime: 2, size: 20 }];
    });
  });

  it("keeps backup listing caches scoped to the project", async () => {
    const path = "/.backups/2026-03-12T00:00:00.000Z";
    const { rerender } = render(
      <TestComponent project_id="project-1" path={path} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("listing").textContent).toBe("alpha.txt");
    });

    rerender(<TestComponent project_id="project-2" path={path} />);

    await waitFor(() => {
      expect(screen.getByTestId("listing").textContent).toBe("beta.txt");
    });
    expect(getBackupFilesMock.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            project_id: "project-1",
          }),
        ],
        [
          expect.objectContaining({
            project_id: "project-2",
          }),
        ],
      ]),
    );
  });

  it("exposes cached backup listings synchronously", async () => {
    const path = "/.backups/2026-03-12T00:00:00.000Z";
    render(<TestComponent project_id="project-1" path={path} />);

    await waitFor(() => {
      expect(screen.getByTestId("listing").textContent).toBe("alpha.txt");
    });

    expect(
      getCachedBackupsListing({
        project_id: "project-1",
        path,
      }),
    ).toEqual([{ name: "alpha.txt", isDir: false, mtime: 1, size: 10 }]);
  });
});
