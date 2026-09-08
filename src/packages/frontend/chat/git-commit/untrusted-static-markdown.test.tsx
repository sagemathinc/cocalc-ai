import { render, screen } from "@testing-library/react";

import { FileContext } from "@cocalc/frontend/lib/file-context";
import { UntrustedStaticMarkdown } from "./untrusted-static-markdown";

test("review markdown cannot inherit trusted project-file rendering", () => {
  const { container } = render(
    <FileContext.Provider value={{ noSanitize: true }}>
      <UntrustedStaticMarkdown
        value={[
          '<a href="javascript:window.attack()">unsafe link</a>',
          '<img alt="unsafe image" src="javascript:window.attack()">',
          "<script>window.attack()</script>",
        ].join("\n")}
      />
    </FileContext.Provider>,
  );

  expect(
    screen.getByText("unsafe link").closest("a")?.getAttribute("href"),
  ).toBeNull();
  expect(
    container.querySelector('img[alt="unsafe image"]')?.getAttribute("src"),
  ).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).not.toContain("window.attack()");
});
