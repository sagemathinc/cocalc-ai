import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { NotificationNav } from "./notification-nav";

it("lets notification labels inherit the menu selection color", () => {
  render(
    <IntlProvider locale="en">
      <NotificationNav
        filter="unread"
        on_click={jest.fn()}
        unread_count={2}
        attention_count={1}
        news_unread={0}
        style={{}}
      />
    </IntlProvider>,
  );
  for (const item of screen.getAllByRole("menuitem")) {
    expect(item.querySelector(".ant-typography")).toHaveStyle({
      color: "inherit",
    });
  }
});
