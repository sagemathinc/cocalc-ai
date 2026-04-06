/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThreadImageUpload } from "../thread-image-upload";

jest.mock("antd-img-crop", () => ({
  __esModule: true,
  default: ({ children, onModalOk }: any) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onModalOk?.(new File(["cropped"], "crop.png", { type: "image/png" }))
        }
      >
        Confirm crop
      </button>
      {children}
    </div>
  ),
}));

describe("ThreadImageUpload", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ uuid: "uuid-123" }),
      text: async () => "",
    })) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("uploads a pasted clipboard image", async () => {
    const onChange = jest.fn();
    render(
      <ThreadImageUpload
        projectId="project-1"
        value=""
        onChange={onChange}
        modalTitle="Edit Chat Image"
      />,
    );

    const pasteTarget = screen.getByText(
      "Click here, then paste an image from the clipboard.",
    );
    fireEvent.focus(pasteTarget);

    const file = new File(["abc"], "clip.png", { type: "image/png" });
    fireEvent.paste(pasteTarget, {
      clipboardData: {
        items: [
          {
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.stringContaining("?uuid=uuid-123"),
      ),
    );
  });

  it("uploads an image chosen through the cropper flow", async () => {
    const onChange = jest.fn();
    render(
      <ThreadImageUpload
        value=""
        onChange={onChange}
        modalTitle="Edit Chat Image"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm crop" }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.stringContaining("?uuid=uuid-123"),
      ),
    );
  });

  it("clears the current image", () => {
    const onChange = jest.fn();
    render(
      <ThreadImageUpload
        value="https://example.test/image.png"
        onChange={onChange}
        modalTitle="Edit Chat Image"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear image" }));

    expect(onChange).toHaveBeenCalledWith("");
  });
});
