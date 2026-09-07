import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { getAmountStyle } from "./amount-style";

it.each([-225, -0.01])("uses primary text for a debit of %s", (amount) => {
  expect(getAmountStyle(amount)).toEqual({
    color: UI_COLORS.text,
    fontWeight: "bold",
    whiteSpace: "nowrap",
  });
});

it.each([0, 2.5, 225])(
  "uses the themed accent for a credit or balance of %s",
  (amount) => {
    expect(getAmountStyle(amount).color).toBe(UI_COLORS.link);
  },
);

it.each([-225, 0, 225])(
  "uses readable secondary text for pending %s",
  (amount) => {
    expect(getAmountStyle(amount, true).color).toBe(UI_COLORS.secondary);
  },
);
