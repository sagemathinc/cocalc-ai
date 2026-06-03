import { act, render, screen, waitFor } from "@testing-library/react";
import {
  collectReduxHookSubscriptionDiagnostics,
  redux,
  useRedux,
} from "./index";

function Value({ storeName }: { storeName: string }) {
  const value = useRedux([storeName, "value"]);
  return <span data-testid="value">{String(value ?? "")}</span>;
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
});
