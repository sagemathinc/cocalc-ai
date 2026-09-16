import { waitFor } from "@testing-library/react";
import { watchTreeOverflow } from "./tree-overflow";

test("uses the full virtual scroll extent, responds to scrolling and filtering, and cleans up", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const viewport = document.createElement("div");
  viewport.dataset.fileTreeVirtualizedScroll = "true";
  root.append(viewport);
  let height = 2000;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 500 },
    scrollHeight: { get: () => height },
  });
  const changed = jest.fn();
  const dispose = watchTreeOverflow(() => host, changed);
  try {
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith({ above: false, below: true }),
    );
    viewport.scrollTop = 1500;
    viewport.dispatchEvent(new Event("scroll"));
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith({ above: true, below: false }),
    );
    height = 100;
    viewport.scrollTop = 0;
    viewport.style.height = "100px";
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith({ above: false, below: false }),
    );
  } finally {
    dispose();
    host.remove();
  }
  changed.mockClear();
  viewport.dispatchEvent(new Event("scroll"));
  expect(changed).not.toHaveBeenCalled();
});
