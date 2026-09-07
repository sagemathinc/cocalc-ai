/** @jest-environment jsdom */
import { readFileSync } from "node:fs";
import { waitFor } from "@testing-library/react";

it("keeps Recovery artwork on the surrounding foreground color", async () => {
  const script = document.createElement("script");
  document.body.appendChild(script);
  const source = readFileSync(require.resolve("./iconfont-3.js"), "utf8");
  // Exercise the downloaded sprite's normal DOM injection.
  window.eval(source);
  document.dispatchEvent(new Event("DOMContentLoaded"));
  await waitFor(() =>
    expect(document.getElementById("icon-disk-snapshot")).not.toBeNull(),
  );
  const symbol = document.getElementById("icon-disk-snapshot");
  expect(symbol).not.toBeNull();
  const paths = symbol!.querySelectorAll("path");
  expect(paths).toHaveLength(2);
  for (const path of paths) {
    expect(path.getAttribute("fill")).toBe("currentColor");
  }
  script.remove();
  symbol!.closest("svg")!.remove();
});
