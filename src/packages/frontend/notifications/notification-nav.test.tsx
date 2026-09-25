import { act, fireEvent, render, screen } from "@testing-library/react";
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

it("shows compact drawer filters as keyboard-operable horizontal tabs", () => {
  const onClick = jest.fn();
  render(
    <IntlProvider locale="en">
      <NotificationNav
        horizontal
        filter="unread"
        on_click={onClick}
        unread_count={2}
        attention_count={1}
        news_unread={0}
        style={{}}
      />
    </IntlProvider>,
  );
  expect(screen.getAllByRole("tab")).toHaveLength(4);
  expect(screen.getByRole("tab", { name: "Unread (2)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const attention = screen.getByRole("tab", { name: "Attention (1)" });
  act(() => attention.focus());
  expect(document.activeElement).toBe(attention);
  fireEvent.keyDown(attention, { key: "Enter", code: "Enter", keyCode: 13 });
  expect(onClick).toHaveBeenCalledWith("attention");
  fireEvent.click(screen.getByRole("tab", { name: "News (0)" }));
  expect(onClick).toHaveBeenCalledWith("allNews");
});
