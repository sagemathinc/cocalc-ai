import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { getAmountStyle as fixedAmountStyle } from "@cocalc/util/db-schema/purchases";

export function getAmountStyle(amount: number, pending = false) {
  return {
    ...fixedAmountStyle(amount),
    color: pending
      ? UI_COLORS.secondary
      : amount >= 0
        ? UI_COLORS.link
        : UI_COLORS.text,
  };
}
