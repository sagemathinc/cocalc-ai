import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getListQuery, setListQuery } from "./list-query";
import { PageSearchBox } from "./page-search-box";
import { closeSearch, getSearchState } from "./search-store";

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));

afterEach(() => {
  act(() => {
    setListQuery("");
    closeSearch();
  });
});

it("shares its text with the sidebar's box; Enter searches this page's kind", async () => {
  const user = userEvent.setup();
  window.history.pushState({}, "", "/projects");
  render(<PageSearchBox scope="projects" />);
  const box = screen.getByRole("searchbox", { name: "Search projects" });
  await user.type(box, "thesis");
  expect(getListQuery()).toBe("thesis");
  // Text typed elsewhere (the sidebar) shows here too.
  act(() => setListQuery("lab"));
  expect(box).toHaveValue("lab");
  box.focus();
  await user.keyboard("{Enter}");
  expect(getSearchState()).toMatchObject({
    open: true,
    query: "lab",
    scope: "projects",
    returnPath: "projects",
  });
});
