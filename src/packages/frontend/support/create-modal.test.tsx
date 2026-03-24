/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "@cocalc/frontend/client/api";
import { uploadBlobImage } from "@cocalc/frontend/blobs/upload-image";
import SupportCreateModal from "./create-modal";
import { openSupportTicketsPage } from "./open";

const mockSettings = jest.fn();
const mockOpenSupportTicketsPage = openSupportTicketsPage as jest.Mock;
const mockedApi = api as jest.Mock;
const mockedUploadBlobImage = uploadBlobImage as jest.Mock;

let supportModalOptions: any = {};

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({
    settings: mockSettings,
  }),
  useTypedRedux: (store: string, key: string) => {
    if (store === "account" && key === "email_address") {
      return "user@example.com";
    }
    if (store === "customize" && key === "zendesk") {
      return true;
    }
    if (store === "page" && key === "supportModalOptions") {
      return supportModalOptions;
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/client/api", () => jest.fn());
jest.mock("@cocalc/frontend/blobs/upload-image", () => ({
  uploadBlobImage: jest.fn(),
}));
jest.mock("@cocalc/frontend/chat/input", () => ({
  __esModule: true,
  default: function ChatInputMock(props) {
    return (
      <textarea
        aria-label="Support body"
        value={props.input}
        onChange={(event) => props.onChange(event.target.value)}
      />
    );
  },
}));
jest.mock("@cocalc/frontend/chat/thread-image-upload", () => ({
  __esModule: true,
  ThreadImageUpload: function ThreadImageUploadMock(props) {
    return (
      <button
        type="button"
        onClick={() => props.onChange("/blobs/paste.png?uuid=123")}
      >
        Add image
      </button>
    );
  },
}));
jest.mock("@cocalc/frontend/public/support/recent-files", () => ({
  __esModule: true,
  default: function RecentFilesMock(props) {
    return (
      <button
        type="button"
        onClick={() =>
          props.onChange([{ project_id: "p".repeat(36), path: "a.ipynb" }])
        }
      >
        Add file
      </button>
    );
  },
}));
jest.mock("./open", () => ({
  __esModule: true,
  default: jest.fn(),
  openSupportTicketsPage: jest.fn(),
}));

describe("SupportCreateModal", () => {
  beforeEach(() => {
    supportModalOptions = {
      body: "Detailed notebook problem with enough context.",
      context: "command palette",
      subject: "Notebook issue",
      type: "problem",
      url: "http://localhost:9100/projects/abc/files/test.ipynb",
    };
    mockSettings.mockReset();
    mockOpenSupportTicketsPage.mockReset();
    mockedApi.mockReset();
    mockedUploadBlobImage.mockReset();
    window.history.replaceState({}, "", "/projects/abc/files/test.ipynb");
  });

  it("submits a support ticket with uploaded image markdown in the body", async () => {
    mockedApi.mockImplementation(async (endpoint: string) => {
      if (endpoint === "support/create-ticket") {
        return { url: "https://example.zendesk.com/requests/123" };
      }
      return {};
    });

    render(<SupportCreateModal />);
    fireEvent.click(screen.getByRole("button", { name: "Add image" }));
    fireEvent.click(screen.getByRole("button", { name: "Add file" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Create support ticket" }),
    );

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith("support/create-ticket", {
        options: expect.objectContaining({
          body: expect.stringContaining("![Image](/blobs/paste.png?uuid=123)"),
          email: "user@example.com",
          files: [{ project_id: "p".repeat(36), path: "a.ipynb" }],
          subject: "Notebook issue",
          type: "problem",
          url: "http://localhost:9100/projects/abc/files/test.ipynb",
        }),
      });
    });
    expect(
      await screen.findByText("Successfully created support ticket"),
    ).not.toBeNull();
  });

  it("captures and uploads a screenshot before submitting when requested", async () => {
    mockedUploadBlobImage.mockResolvedValue({
      filename: "support-screenshot.png",
      url: "/blobs/support-screenshot.png?uuid=456",
      uuid: "456",
    });
    mockedApi.mockResolvedValue({
      url: "https://example.zendesk.com/requests/999",
    });
    (navigator as any).mediaDevices = {
      getDisplayMedia: jest.fn(async () => ({
        getTracks: () => [{ stop: jest.fn() }],
      })),
    };
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: jest.fn(async function play() {
        Object.defineProperty(this, "readyState", {
          configurable: true,
          value: HTMLMediaElement.HAVE_CURRENT_DATA,
        });
        Object.defineProperty(this, "videoWidth", {
          configurable: true,
          value: 100,
        });
        Object.defineProperty(this, "videoHeight", {
          configurable: true,
          value: 50,
        });
      }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({ drawImage: jest.fn() }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: (callback: (blob: Blob) => void) =>
        callback(new Blob(["png"], { type: "image/png" })),
    });

    render(<SupportCreateModal />);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Include a screenshot when I submit this ticket",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create support ticket" }),
    );

    await waitFor(() => {
      expect(mockedUploadBlobImage).toHaveBeenCalledTimes(1);
      expect(mockedApi).toHaveBeenCalledWith("support/create-ticket", {
        options: expect.objectContaining({
          body: expect.stringContaining(
            "![Screenshot](/blobs/support-screenshot.png?uuid=456)",
          ),
        }),
      });
    });
  });
});
