import { render, screen } from "@testing-library/react";
import { useProject } from "./common";

const getMyGroup = jest.fn();
const useTypedRedux = jest.fn();
const syncTable = jest.fn();
let projectRecord: Map<string, string> | undefined;

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({
      get_my_group: getMyGroup,
    }),
  },
  useEffect: jest.requireActual("react").useEffect,
  useMemo: jest.requireActual("react").useMemo,
  useProjectFromMap: () => projectRecord,
  useState: jest.requireActual("react").useState,
  useTypedRedux: (...args: any[]) => useTypedRedux(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    sync_client: {
      sync_table: (...args: any[]) => syncTable(...args),
    },
  },
}));

function TestComponent({ project_id }: { project_id: string }) {
  const { project, group } = useProject(project_id);
  return (
    <div>
      <span data-testid="group">{group ?? ""}</span>
      <span data-testid="project">{project?.get("title") ?? ""}</span>
    </div>
  );
}

describe("useProject", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    projectRecord = undefined;
    useTypedRedux.mockReset();
  });

  it("updates unresolved membership and account changes without changing the project id", () => {
    getMyGroup.mockReturnValue(undefined);
    const view = render(<TestComponent project_id="project-1" />);
    expect(screen.getByTestId("group")).toBeEmptyDOMElement();
    projectRecord = new Map([["title", "Loaded project"]]);
    const projectMap = new Map([["project-1", projectRecord]]);
    useTypedRedux.mockImplementation((store, field) =>
      field === "project_map"
        ? projectMap
        : field === "account_id"
          ? "alice"
          : undefined,
    );
    getMyGroup.mockReturnValue("collaborator");
    view.rerender(<TestComponent project_id="project-1" />);
    expect(screen.getByTestId("group")).toHaveTextContent("collaborator");
    expect(screen.getByTestId("project")).toHaveTextContent("Loaded project");
    useTypedRedux.mockImplementation((store, field) =>
      field === "project_map"
        ? projectMap
        : field === "account_id"
          ? "bob"
          : undefined,
    );
    getMyGroup.mockReturnValue("viewer");
    view.rerender(<TestComponent project_id="project-1" />);
    expect(screen.getByTestId("group")).toHaveTextContent("viewer");
  });

  it("closes the previous admin sync table and ignores its later updates", () => {
    const firstProject = new Map([["title", "first"]]);
    const secondProject = new Map([["title", "second"]]);

    const firstListeners = new Set<() => void>();
    const secondListeners = new Set<() => void>();
    let firstClosed = false;

    const firstTable = {
      on: jest.fn((_event: string, cb: () => void) => {
        firstListeners.add(cb);
      }),
      get: jest.fn(() => firstProject),
      close: jest.fn(() => {
        firstClosed = true;
      }),
    };
    const secondTable = {
      on: jest.fn((_event: string, cb: () => void) => {
        secondListeners.add(cb);
      }),
      get: jest.fn(() => secondProject),
      close: jest.fn(),
    };

    syncTable.mockReturnValueOnce(firstTable).mockReturnValueOnce(secondTable);
    useTypedRedux.mockReturnValue(undefined);
    getMyGroup.mockImplementation((project_id: string) =>
      project_id === "project-1" ? "admin" : "admin",
    );

    const { rerender } = render(<TestComponent project_id="project-1" />);
    expect(screen.getByTestId("project").textContent).toBe("first");

    rerender(<TestComponent project_id="project-2" />);
    expect(firstTable.close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("project").textContent).toBe("second");

    firstListeners.forEach((cb) => cb());

    expect(firstClosed).toBe(true);
    expect(screen.getByTestId("project").textContent).toBe("second");
    expect(secondListeners.size).toBe(1);
  });
});
