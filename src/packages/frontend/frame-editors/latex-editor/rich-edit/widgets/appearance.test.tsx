import { fireEvent, render, screen } from "@testing-library/react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { WidgetProps } from "../types";
import { Author, DateWidget, Maketitle, Title } from "./document";
import { Widget } from "./common";
import { renderInline } from "./render-inline";

jest.mock("@cocalc/frontend/components", () => ({
  Tooltip: ({ children }) => <>{children}</>,
}));

const props: WidgetProps = {
  descriptor: {
    type: "title",
    from: { line: 0, ch: 0 },
    to: { line: 0, ch: 12 },
    source: "\\title{Example}",
    payload: { content: "Example" },
  },
  onActivate: jest.fn(),
};

it.each([Title, Author, DateWidget])(
  "themes document preview text: %p",
  (Component) => {
    render(<Component {...props} />);
    expect(screen.getByText("Example").style.color).toBe(
      Component === DateWidget ? UI_COLORS.secondary : UI_COLORS.text,
    );
  },
);

it("pairs placeholder chip text with a themed background", () => {
  render(<Maketitle {...props} />);
  const chip = screen.getByText("Title block");
  expect(chip.style.background).toBe(UI_COLORS.inset);
  expect(chip.style.color).toBe(UI_COLORS.text);
});

it("themes default widget text and hover without changing authored colors", () => {
  render(
    <Widget {...props}>
      <span>Preview</span>
      {renderInline("\\textcolor{red}{Authored}")}
    </Widget>,
  );
  const widget = screen.getByText("Preview").parentElement!;
  expect(widget.style.color).toBe(UI_COLORS.text);
  fireEvent.mouseEnter(widget);
  expect(widget.style.background).toBe(UI_COLORS.hover);
  expect(screen.getByText("Authored").style.color).toBe("red");
  fireEvent.mouseLeave(widget);
  expect(widget.style.background).toBe("transparent");
});
