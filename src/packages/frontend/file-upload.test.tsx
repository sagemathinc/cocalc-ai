/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react";
import { BlobUpload } from "./file-upload";
import { uploadBlobImage } from "@cocalc/frontend/blobs/upload-image";

const mockUploadBlobImage = uploadBlobImage as jest.Mock;

let latestDropzone: any;

(globalThis as any).$ = {
  extend: (...args: any[]) => {
    const values = args[0] === true ? args.slice(1) : args;
    return Object.assign({}, ...values);
  },
};

jest.mock("dropzone", () => {
  return class MockDropzone {
    options: any;
    hiddenFileInput = { click: jest.fn() };
    handlers: Record<string, Array<(...args: any[]) => void>> = {};

    constructor(_node: any, options: any) {
      this.options = options;
      latestDropzone = this;
    }

    on(name: string, handler: (...args: any[]) => void) {
      this.handlers[name] = [...(this.handlers[name] ?? []), handler];
    }

    off() {
      this.handlers = {};
    }

    destroy() {}

    getActiveFiles() {
      return [];
    }

    removeAllFiles() {}

    addFile(file: any) {
      for (const handler of this.handlers.addedfile ?? []) {
        handler(file);
      }
    }
  };
});

jest.mock("@cocalc/frontend/blobs/upload-image", () => ({
  uploadBlobImage: jest.fn(),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: jest.fn(() => ({ log: jest.fn() })),
  },
  useTypedRedux: jest.fn(() => undefined),
}));

jest.mock("@cocalc/frontend/course", () => ({
  useStudentProjectFunctionality: () => ({}),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Tip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

describe("BlobUpload", () => {
  beforeEach(() => {
    latestDropzone = undefined;
    mockUploadBlobImage.mockReset();
  });

  it("uploads non-project files via the blob upload helper", async () => {
    mockUploadBlobImage.mockResolvedValue({
      filename: "clip.png",
      url: "/blobs/clip.png?uuid=abc",
      uuid: "abc",
    });
    const complete = jest.fn();
    const sending = jest.fn();
    const dropzoneRef = { current: null as any };
    render(
      <BlobUpload
        show_upload={false}
        project_id=""
        dropzone_ref={dropzoneRef}
        event_handlers={{ complete, sending }}
      >
        <div>body</div>
      </BlobUpload>,
    );

    const file = new File(["image"], "clip.png", { type: "image/png" });
    latestDropzone.addFile(file);

    await waitFor(() => expect(mockUploadBlobImage).toHaveBeenCalledTimes(1));
    expect(mockUploadBlobImage).toHaveBeenCalledWith({
      file,
      filename: "clip.png",
      projectId: undefined,
    });
    expect(sending).toHaveBeenCalledWith(file);
    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          url: "/blobs/clip.png?uuid=abc",
          uuid: "abc",
        }),
      ),
    );
  });

  it("passes project ids through when uploading project-scoped blobs", async () => {
    mockUploadBlobImage.mockResolvedValue({
      filename: "clip.png",
      url: "/blobs/clip.png?uuid=project-abc",
      uuid: "project-abc",
    });
    render(
      <BlobUpload show_upload={false} project_id="project-1">
        <div>body</div>
      </BlobUpload>,
    );

    latestDropzone.addFile(
      new File(["image"], "clip.png", { type: "image/png" }),
    );

    await waitFor(() =>
      expect(mockUploadBlobImage).toHaveBeenCalledWith({
        file: expect.any(File),
        filename: "clip.png",
        projectId: "project-1",
      }),
    );
  });
});
