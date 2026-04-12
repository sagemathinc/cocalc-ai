import { act, render, screen, waitFor } from "@testing-library/react";
import Bootlog from "./bootlog";

const lroStream = jest.fn();

jest.mock("antd", () => {
  const Div = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  const Progress = ({ children, strokeColor, ...props }: any) => (
    <div {...props}>{children}</div>
  );
  const Switch = ({ checked, onChange }: any) => (
    <button type="button" onClick={() => onChange(!checked)}>
      switch
    </button>
  );
  return {
    Progress,
    Space: Div,
    Spin: () => <div>spin</div>,
    Switch,
    Tooltip: Div,
  };
});

jest.mock("./context", () => ({
  useProjectContext: () => ({
    project_id: "project-1",
    isRunning: true,
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => undefined,
}));

jest.mock("@cocalc/frontend/components/error", () => () => null);
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => () => null);
jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: () => null,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      lroStream: (...args: any[]) => lroStream(...args),
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("Bootlog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ignores a stale lro stream that resolves after a newer one", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    lroStream
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const firstStream = {
      getAll: jest.fn(() => [
        { type: "progress", phase: "boot", message: "first log" },
      ]),
      on: jest.fn(),
      close: jest.fn(),
    };
    const secondStream = {
      getAll: jest.fn(() => [
        { type: "progress", phase: "boot", message: "second log" },
      ]),
      on: jest.fn(),
      close: jest.fn(),
    };

    const { rerender } = render(
      <Bootlog
        lro={{ op_id: "op-1", scope_type: "project", scope_id: "project-1" }}
      />,
    );

    rerender(
      <Bootlog
        lro={{ op_id: "op-2", scope_type: "project", scope_id: "project-1" }}
      />,
    );

    await act(async () => {
      second.resolve(secondStream);
    });

    await waitFor(() => {
      expect(screen.getByText("second log")).toBeTruthy();
    });

    await act(async () => {
      first.resolve(firstStream);
    });

    await waitFor(() => {
      expect(screen.getByText("second log")).toBeTruthy();
    });
    expect(screen.queryByText("first log")).toBeNull();
    expect(firstStream.close).toHaveBeenCalledTimes(1);
  });
});
