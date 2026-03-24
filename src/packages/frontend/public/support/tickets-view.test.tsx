/** @jest-environment jsdom */

import { renderTicketDescription } from "./tickets-view";

describe("renderTicketDescription", () => {
  it("renders basic markdown and linkifies plain URLs", () => {
    const html = renderTicketDescription(
      "Hello **world**\n\nSee https://cocalc.com",
    );

    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain('href="https://cocalc.com"');
    expect(html).toContain('target="_blank"');
  });

  it("does not render raw html tags", () => {
    const html = renderTicketDescription("<script>alert(1)</script>");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
