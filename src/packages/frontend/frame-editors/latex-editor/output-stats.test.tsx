import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { OutputStats } from "./output-stats";
import { OUTPUT_HEADER_STYLE } from "./util";

it("pairs statistics text and shared header with themed surfaces", () => {
  render(
    <IntlProvider locale="en">
      <OutputStats
        wordCountLoading={false}
        wordCount="Words: 100"
        refreshWordCount={jest.fn()}
        uiFontSize={14}
      />
    </IntlProvider>,
  );
  expect(screen.getByText("Words: 100")).toHaveStyle({
    color: UI_COLORS.text,
    background: UI_COLORS.surface,
  });
  expect(OUTPUT_HEADER_STYLE.backgroundColor).toBe(UI_COLORS.surface);
  expect(OUTPUT_HEADER_STYLE.color).toBe(UI_COLORS.text);
});
