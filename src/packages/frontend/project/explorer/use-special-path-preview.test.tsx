import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as archiveInfo from "@cocalc/frontend/project/archive-info";
import { useSpecialPathPreview } from "./use-special-path-preview";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";

const getSnapshotFileText = jest.fn();

jest.mock("antd", () => ({
  message: {
    success: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/project/archive-info", () => ({
  getSnapshotFileText: (...args: any[]) => getSnapshotFileText(...args),
  getBackups: jest.fn(),
  getBackupFileText: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          restoreBackup: jest.fn(),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/project/find/restore-modal", () => ({
  __esModule: true,
  default: ({ open, preview, onCancel }: any) => (
    <div>
      <span data-testid="modal-open">{open ? "yes" : "no"}</span>
      <span data-testid="preview">
        {preview?.content ??
          preview?.error ??
          (preview?.loading ? "loading" : "")}
      </span>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function TestComponent() {
  const { onOpenSpecial, modal } = useSpecialPathPreview({
    project_id: "project-1",
    actions: {
      fs: jest.fn(),
      open_directory: jest.fn(),
      trackRestoreOp: jest.fn(),
    } as any,
    current_path: `${SNAPSHOTS}/snap-1`,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => onOpenSpecial(`${SNAPSHOTS}/snap-1/file.txt`, false)}
      >
        open
      </button>
      {modal}
    </div>
  );
}

describe("useSpecialPathPreview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (archiveInfo.getBackups as jest.Mock).mockResolvedValue([]);
  });

  it("invalidates a pending preview when the modal is closed", async () => {
    const request = deferred<{ content: string; truncated: boolean }>();
    getSnapshotFileText.mockReturnValue(request.promise);

    render(<TestComponent />);

    fireEvent.click(screen.getByText("open"));

    await waitFor(() => {
      expect(screen.getByTestId("modal-open").textContent).toBe("yes");
      expect(screen.getByTestId("preview").textContent).toBe("loading");
    });

    fireEvent.click(screen.getByText("cancel"));

    await waitFor(() => {
      expect(screen.getByTestId("modal-open").textContent).toBe("no");
      expect(screen.getByTestId("preview").textContent).toBe("");
    });

    await act(async () => {
      request.resolve({ content: "stale preview", truncated: false });
    });

    await waitFor(() => {
      expect(screen.getByTestId("modal-open").textContent).toBe("no");
      expect(screen.getByTestId("preview").textContent).toBe("");
    });
  });
});
