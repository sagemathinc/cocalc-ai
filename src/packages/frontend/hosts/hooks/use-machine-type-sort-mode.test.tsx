import { fireEvent, render, screen } from "@testing-library/react";
import { React } from "@cocalc/frontend/app-framework";
import { useMachineTypeSortMode } from "./use-machine-type-sort-mode";

function TestMachineTypeSortMode() {
  const [mode, setMode] = useMachineTypeSortMode();
  return (
    <>
      <div data-testid="mode">{mode}</div>
      <button onClick={() => setMode("type")}>set-type</button>
      <button onClick={() => setMode("price")}>set-price</button>
      <button onClick={() => setMode("cpu")}>set-cpu</button>
      <button onClick={() => setMode("value")}>set-value</button>
    </>
  );
}

describe("useMachineTypeSortMode", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to price", () => {
    render(<TestMachineTypeSortMode />);
    expect(screen.getByTestId("mode").textContent).toBe("price");
  });

  it("reads and persists the selected sort mode", () => {
    window.localStorage.setItem("cocalc:hosts:machineTypeSort", "type");
    render(<TestMachineTypeSortMode />);
    expect(screen.getByTestId("mode").textContent).toBe("type");

    fireEvent.click(screen.getByText("set-cpu"));
    expect(screen.getByTestId("mode").textContent).toBe("cpu");
    expect(window.localStorage.getItem("cocalc:hosts:machineTypeSort")).toBe(
      "cpu",
    );
  });

  it("accepts the value sort mode from persisted storage", () => {
    window.localStorage.setItem("cocalc:hosts:machineTypeSort", "value");
    render(<TestMachineTypeSortMode />);
    expect(screen.getByTestId("mode").textContent).toBe("value");
  });
});
