/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { PAGE_HEADER_HEIGHT, PageHeader } from "./page-header";

// One row for every page that shows a single thing: keep it compact.
test("a page header is one 40px row with the thing's identity strip", () => {
  render(
    <PageHeader aria-label="Thing" identityColor="#ff5500">
      <h1>Title</h1>
    </PageHeader>,
  );
  const header = screen.getByRole("banner", { name: "Thing" });
  expect(PAGE_HEADER_HEIGHT).toBe(40);
  expect(header.style.height).toBe("40px");
  expect(header.style.display).toBe("flex");
  expect(header.style.boxShadow).toContain("inset 0 3px 0");
});

test("no strip without an identity color", () => {
  render(<PageHeader aria-label="Plain" />);
  expect(screen.getByRole("banner", { name: "Plain" }).style.boxShadow).toBe(
    "",
  );
});
