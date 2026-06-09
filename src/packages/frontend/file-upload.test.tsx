/** @jest-environment jsdom */

import { act, render, waitFor } from "@testing-library/react";
import { BlobUpload, FileUploadWrapper } from "./file-upload";

let latestDropzone: any;
const mockEnsureProjectHostBrowserSessionForProject = jest.fn();
const mockRouteProjectHostHttpUrl = jest.fn();

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

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      ensureProjectHostBrowserSessionForProject: (...args: any[]) =>
        mockEnsureProjectHostBrowserSessionForProject(...args),
      routeProjectHostHttpUrl: (...args: any[]) =>
        mockRouteProjectHostHttpUrl(...args),
    },
  },
}));

describe("BlobUpload", () => {
  beforeEach(() => {
    latestDropzone = undefined;
    mockEnsureProjectHostBrowserSessionForProject.mockReset();
    mockRouteProjectHostHttpUrl.mockReset();
    mockRouteProjectHostHttpUrl.mockImplementation(
      async ({ url }) => `https://host.example${url}`,
    );
  });

  it("routes project file uploads directly to the project host", async () => {
    render(
      <FileUploadWrapper
        show_upload={false}
        project_id="project-1"
        dest_path="/home/user"
      >
        <div>body</div>
      </FileUploadWrapper>,
    );

    await waitFor(() => {
      expect(latestDropzone).toBeTruthy();
    });

    expect(mockEnsureProjectHostBrowserSessionForProject).toHaveBeenCalledWith({
      project_id: "project-1",
    });
    expect(mockRouteProjectHostHttpUrl).toHaveBeenCalledWith({
      project_id: "project-1",
      url: "/project-1/upload?path=%2Fhome%2Fuser",
    });
    expect(latestDropzone.options.url).toBe(
      "https://host.example/project-1/upload?path=%2Fhome%2Fuser",
    );
    expect(latestDropzone.options.withCredentials).toBe(true);
  });

  it("uses project-scoped blob uploads when project_id is set", () => {
    render(
      <BlobUpload show_upload={false} project_id="project-1">
        <div>body</div>
      </BlobUpload>,
    );

    expect(latestDropzone.options.url).toBe("/blobs?project_id=project-1");
    expect(
      mockEnsureProjectHostBrowserSessionForProject,
    ).not.toHaveBeenCalled();
    expect(mockRouteProjectHostHttpUrl).not.toHaveBeenCalled();
  });

  it("does not tell users to start the project in the upload preview", () => {
    render(
      <BlobUpload show_upload={false} project_id="project-1">
        <div>body</div>
      </BlobUpload>,
    );

    expect(latestDropzone.options.previewTemplate).not.toContain(
      "You must start the project",
    );
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

  it("does not rerender when close_preview is called with no visible files", () => {
    const closePreviewRef = {
      current: null as null | ((removeAll?: boolean) => void),
    };
    const renderSpy = jest.fn();

    function Marker() {
      renderSpy();
      return <div>body</div>;
    }

    render(
      <BlobUpload
        show_upload={false}
        project_id=""
        close_preview_ref={closePreviewRef}
      >
        <Marker />
      </BlobUpload>,
    );

    expect(typeof closePreviewRef.current).toBe("function");
    renderSpy.mockClear();

    act(() => {
      closePreviewRef.current?.(true);
    });

    expect(renderSpy).not.toHaveBeenCalled();
  });
});
