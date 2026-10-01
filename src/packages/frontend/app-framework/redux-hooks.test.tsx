import { act, render, screen, waitFor } from "@testing-library/react";
import {
  collectReduxHookSubscriptionDiagnostics,
  redux,
  useRedux,
} from "./index";
import { project_redux_name } from "@cocalc/util/redux/name";
import type { Store } from "@cocalc/util/redux/Store";

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

  it("attaches a named-store subscription created before lazy initialization", async () => {
    const storeName = "test-lazy-notifications";
    storeNames.push(storeName);
    const view = render(
      <div>
        <Value storeName={storeName} />
      </div>,
    );
    expect(screen.getByTestId("value")).toHaveTextContent("");
    expect(
      collectReduxHookSubscriptionDiagnostics().topSubscriptions.find(
        ({ storeName: name }) => name === storeName,
      ),
    ).toMatchObject({ waitingForStore: true, storeAttached: false });

    let store!: Store<{ value: number }>;
    act(() => {
      store = redux.createStore(storeName, { value: 1 });
    });
    // The notification badge mounts before the store; the drawer mounts later
    // and shares its subscription. Both must observe the same stored value.
    view.rerender(
      <div>
        <Value storeName={storeName} />
        <Value storeName={storeName} />
      </div>,
    );
    await waitFor(() =>
      expect(
        screen.getAllByTestId("value").map((node) => node.textContent),
      ).toEqual(["1", "1"]),
    );
    expect(store.listenerCount("change")).toBe(1);
    expect(
      collectReduxHookSubscriptionDiagnostics().topSubscriptions.find(
        ({ storeName: name }) => name === storeName,
      ),
    ).toMatchObject({
      waitingForStore: false,
      storeAttached: true,
      subscriberCount: 2,
    });
    act(() => store.setState({ value: 0 }));
    await waitFor(() =>
      expect(
        screen.getAllByTestId("value").map((node) => node.textContent),
      ).toEqual(["0", "0"]),
    );
    view.unmount();
    expect(store.listenerCount("change")).toBe(0);
  });

  it("stops waiting for a lazy named store when its last consumer unmounts", () => {
    const storeName = "test-lazy-notifications-unmounted";
    storeNames.push(storeName);
    const view = render(<Value storeName={storeName} />);
    view.unmount();
    expect(
      collectReduxHookSubscriptionDiagnostics().topSubscriptions.find(
        ({ storeName: name }) => name === storeName,
      ),
    ).toBeUndefined();
    const store = redux.createStore(storeName, { value: 1 });
    expect(store.listenerCount("change")).toBe(0);
  });
});
