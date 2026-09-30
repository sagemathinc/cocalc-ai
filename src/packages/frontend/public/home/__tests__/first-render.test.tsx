/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://cocalc.ai/"}
 */

import { render, screen, within } from "@testing-library/react";

import PublicHomeApp from "../app";
import { PUBLIC_HOME_HIGHLIGHTS } from "@cocalc/util/public-home-content";

// The Home route renders before /customize returns, with no config. On
// cocalc.ai that first render must already show all three highlights, or the
// hero shifts on phones when the config arrives.
describe("PublicHomeApp first render on cocalc.ai", () => {
  it("shows all three highlights before the site config arrives", () => {
    expect(window.location.host).toBe("cocalc.ai");
    render(<PublicHomeApp />);
    const hero = screen.getByRole("region", { name: "CoCalc hero" });

    expect(
      within(hero)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([...PUBLIC_HOME_HIGHLIGHTS]);
  });
});
