/** @jest-environment jsdom */

import { render } from "@testing-library/react";
import { BlobUpload } from "./file-upload";

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
  };
});

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
  });

  it("uses project-scoped blob uploads when project_id is set", () => {
    render(
      <BlobUpload show_upload={false} project_id="project-1">
        <div>body</div>
      </BlobUpload>,
    );

    expect(latestDropzone.options.url).toBe("/blobs?project_id=project-1");
  });

  it("uses non-project blob uploads when project_id is not set", () => {
    render(
      <BlobUpload show_upload={false} project_id="">
        <div>body</div>
      </BlobUpload>,
    );

    expect(latestDropzone.options.url).toBe("/blobs");
  });

  it("forwards readable server upload errors", () => {
    const error = jest.fn();
    render(
      <BlobUpload show_upload={false} project_id="" event_handlers={{ error }}>
        <div>body</div>
      </BlobUpload>,
    );

    latestDropzone.handlers.error[0]({}, "upload failed", {
      responseText: "missing project_id or account_id",
    });

    expect(error).toHaveBeenCalledWith({}, "missing project_id or account_id", {
      responseText: "missing project_id or account_id",
    });
  });
});
