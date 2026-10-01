import { act, render, screen, waitFor } from "@testing-library/react";
import {
  collectReduxHookSubscriptionDiagnostics,
  redux,
  useRedux,
} from "./index";
import { project_redux_name } from "@cocalc/util/redux/name";

function Value({ storeName }: { storeName: string }) {
  const value = useRedux([storeName, "value"]);
  return <span data-testid="value">{String(value ?? "")}</span>;
}

function ProjectValue({ projectId }: { projectId: string }) {
  const value = useRedux(["value"], projectId);
  return <span data-testid="project-value">{String(value ?? "")}</span>;
}

describe("useRedux", () => {
  const storeNames: string[] = [];

  afterEach(() => {
    for (const storeName of storeNames.splice(0)) {
      redux.removeStore(storeName);
    }
  });

  it("shares one store listener across identical hook subscriptions", async () => {
    const storeName = `test-redux-hooks-${Date.now()}`;
    storeNames.push(storeName);
    const store = redux.createStore(storeName, { value: "initial" });

    const { unmount } = render(
      <>
        <Value storeName={storeName} />
        <Value storeName={storeName} />
      </>,
    );

    await waitFor(() => {
      expect(
        screen.getAllByTestId("value").map((node) => node.textContent),
      ).toEqual(["initial", "initial"]);
    });
    expect(store.listenerCount("change")).toBe(1);

    const subscription =
      collectReduxHookSubscriptionDiagnostics().topSubscriptions.find(
        ({ storeName: name, path }) =>
          name === storeName && path.join(".") === "value",
      );
    expect(subscription?.subscriberCount).toBe(2);

    act(() => {
      store.setState({ value: "next" });
    });

    await waitFor(() => {
      expect(
        screen.getAllByTestId("value").map((node) => node.textContent),
      ).toEqual(["next", "next"]);
    });

    unmount();
    expect(store.listenerCount("change")).toBe(0);
  });

  it("waits quietly for a named store that is created after first render", async () => {
    const storeName = `test-redux-hooks-lazy-${Date.now()}`;
    storeNames.push(storeName);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { unmount } = render(<Value storeName={storeName} />);
      expect(screen.getByTestId("value")).toHaveTextContent("");
      expect(
        collectReduxHookSubscriptionDiagnostics().topSubscriptions.find(
          ({ storeName: name }) => name === storeName,
        )?.waitingForStore,
      ).toBe(true);

      let store;
      act(() => {
        store = redux.createStore(storeName, { value: "ready" });
      });
      await waitFor(() => {
        expect(screen.getByTestId("value")).toHaveTextContent("ready");
      });

      act(() => {
        store.setState({ value: "next" });
      });
      await waitFor(() => {
        expect(screen.getByTestId("value")).toHaveTextContent("next");
      });
      expect(warn).not.toHaveBeenCalled();
      unmount();
      expect(store.listenerCount("change")).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("waits for a project store without invoking its creating accessor", async () => {
    const projectId = "8fdffb16-29e7-4271-a5f0-c364300b8df9";
    const storeName = project_redux_name(projectId);
    storeNames.push(storeName);
    const getProjectStore = jest.spyOn(redux, "getProjectStore");

    render(<ProjectValue projectId={projectId} />);

    expect(screen.getByTestId("project-value")).toHaveTextContent("");
    expect(getProjectStore).not.toHaveBeenCalled();
    expect(
      collectReduxHookSubscriptionDiagnostics().topSubscriptions.find(
        ({ storeName: name }) => name === storeName,
      )?.waitingForStore,
    ).toBe(true);

    act(() => {
      redux.createStore(storeName, { value: "ready" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-value")).toHaveTextContent("ready");
    });
    expect(getProjectStore).not.toHaveBeenCalled();
    getProjectStore.mockRestore();
  });

  it("stops waiting for a named store when its last consumer unmounts", () => {
    const storeName = `test-redux-hooks-unmounted-${Date.now()}`;
    storeNames.push(storeName);
    const { unmount } = render(<Value storeName={storeName} />);
    unmount();

    const store = redux.createStore(storeName, { value: "too late" });
    expect(store.listenerCount("change")).toBe(0);
    expect(
      collectReduxHookSubscriptionDiagnostics().topSubscriptions.find(
        ({ storeName: name }) => name === storeName,
      ),
    ).toBeUndefined();
  });
});
