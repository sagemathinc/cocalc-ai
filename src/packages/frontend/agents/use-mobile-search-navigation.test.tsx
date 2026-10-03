import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarSearchBox } from "@cocalc/frontend/search/sidebar-search-box";
import { useMobileSearchNavigation } from "./use-mobile-search-navigation";

jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));

function Workspace({ narrow = true, active = true }) {
  const [mobileList, setMobileList] = useState(true);
  const [query, setQuery] = useState("");
  const [run, setRun] = useState(0);
  const contentRef = useRef<HTMLElement>(null);
  useMobileSearchNavigation({
    active,
    isNarrow: narrow,
    searchOpen: run > 0,
    searchRun: run,
    mobileList,
    setMobileList,
    contentRef,
  });
  return (
    <>
      <aside
        aria-label="Sidebar"
        style={{ display: narrow && !mobileList ? "none" : undefined }}
      >
        <SidebarSearchBox
          label="Search"
          value={query}
          onChange={setQuery}
          onSubmit={() => setRun((n) => n + 1)}
        />
      </aside>
      <section
        ref={contentRef}
        aria-label="Workspace content"
        tabIndex={-1}
        style={{ display: narrow && mobileList ? "none" : undefined }}
      >
        <button onClick={() => setMobileList(true)}>Show sidebar</button>
        {run > 0 && (
          <section aria-label="Search results">Results for {query}</section>
        )}
      </section>
    </>
  );
}

it.each(["Enter", "button"])(
  "reveals mobile search and hands off focus after %s submission",
  async (method) => {
    const user = userEvent.setup();
    render(<Workspace />);
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "notes");
    if (method === "Enter") await user.keyboard("{Enter}");
    else
      await user.click(
        screen.getByRole("button", { name: /Search everything/ }),
      );
    expect(
      screen.getByRole("region", { name: "Search results" }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Workspace content" }),
    ).toHaveFocus();
    expect(screen.queryByRole("searchbox", { name: "Search" })).toBeNull();
    // Reopening the sidebar is allowed even while results remain open.
    await user.tab();
    expect(screen.getByRole("button", { name: "Show sidebar" })).toHaveFocus();
    await user.keyboard("{Enter}");
    const search = screen.getByRole("searchbox", { name: "Search" });
    search.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("region", { name: "Search results" }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Workspace content" }),
    ).toHaveFocus();
  },
);

it("does not steal desktop search focus", async () => {
  const user = userEvent.setup();
  render(<Workspace narrow={false} />);
  const search = screen.getByRole("searchbox", { name: "Search" });
  await user.type(search, "notes{Enter}");
  expect(search).toHaveFocus();
  expect(screen.getByRole("region", { name: "Search results" })).toBeVisible();
});

it("does not move focus from an inactive workspace", async () => {
  const user = userEvent.setup();
  render(<Workspace active={false} />);
  const search = screen.getByRole("searchbox", { name: "Search" });
  await user.type(search, "notes{Enter}");
  expect(search).toHaveFocus();
  expect(screen.queryByRole("region", { name: "Search results" })).toBeNull();
});
