import { render, screen } from "@testing-library/react";
import { DiffRenderBoundary } from "./render-boundary";
import { useEffect } from "react";

test("changed sources recover failures without remounting healthy children", () => {
  const mounts = jest.fn();
  function Child({ fail }: { fail: boolean }) {
    useEffect(() => {
      mounts();
    }, []);
    if (fail) throw Error("broken source");
    return <span>Loaded source</span>;
  }
  const logged = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const view = (key: string, fail: boolean) => (
      <DiffRenderBoundary resetKeys={[key]}>
        <Child fail={fail} />
      </DiffRenderBoundary>
    );
    const { rerender } = render(view("first", false));
    rerender(view("second", false));
    expect(mounts).toHaveBeenCalledTimes(1);
    rerender(view("second", true));
    expect(screen.getByRole("alert")).toBeVisible();
    rerender(view("second", false));
    expect(screen.getByRole("alert")).toBeVisible();
    rerender(view("third", false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Loaded source")).toBeVisible();
    expect(mounts).toHaveBeenCalledTimes(2);
  } finally {
    logged.mockRestore();
  }
});

test("renderer failure offers recovery without referring to the removed Classic mode", () => {
  function Broken(): never {
    throw Error("renderer failed");
  }
  const logged = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <DiffRenderBoundary>
        <Broken />
      </DiffRenderBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Try reopening this view or reloading the page.",
    );
    expect(screen.queryByText(/Classic/)).toBeNull();
  } finally {
    logged.mockRestore();
  }
});
