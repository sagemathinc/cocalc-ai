/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://cocalc.ai/"}
 */

import { render, screen, within } from "@testing-library/react";

import PublicHomeApp from "../app";
import {
  PUBLIC_HOME_AGENTS_HIGHLIGHT,
  PUBLIC_HOME_HIGHLIGHTS,
} from "@cocalc/util/public-home-content";

// A canonical browser host is not enough to infer branding before /customize.
describe("PublicHomeApp first render on cocalc.ai", () => {
  it.each([
    { site_name: "University CoCalc" },
    { site_name: "CoCalc", logo_square: "/custom-logo.svg" },
  ])(
    "does not flash the agent highlight before custom branding arrives: %j",
    (config) => {
      expect(window.location.host).toBe("cocalc.ai");
      const view = render(<PublicHomeApp />);
      const hero = screen.getByRole("region", { name: "CoCalc hero" });
      expect(
        within(hero)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(
        PUBLIC_HOME_HIGHLIGHTS.filter(
          (text) => text !== PUBLIC_HOME_AGENTS_HIGHLIGHT,
        ),
      );
      view.rerender(<PublicHomeApp config={{ is_authenticated: false }} />);
      expect(within(hero).queryByText(PUBLIC_HOME_AGENTS_HIGHLIGHT)).toBeNull();
      view.rerender(<PublicHomeApp config={config} />);
      expect(within(hero).queryByText(PUBLIC_HOME_AGENTS_HIGHLIGHT)).toBeNull();
    },
  );

  it("uses the browser host once default branding is known", () => {
    const view = render(<PublicHomeApp />);
    view.rerender(<PublicHomeApp config={{ site_name: "CoCalc" }} />);
    const hero = screen.getByRole("region", { name: "CoCalc hero" });
    expect(within(hero).getByText(PUBLIC_HOME_AGENTS_HIGHLIGHT)).not.toBeNull();
  });
});
