import { render } from "@testing-library/react";
import StaticMarkdown from "../static-markdown";
import * as parser from "../markdown-to-slate";

test("unchanged Markdown is not reparsed on parent or internal state renders", () => {
  const parse = jest.spyOn(parser, "markdown_to_slate");
  try {
    const { rerender } = render(<StaticMarkdown value="first value" />);
    expect(parse).toHaveBeenCalledTimes(1);
    rerender(<StaticMarkdown value="first value" style={{ fontSize: 18 }} />);
    expect(parse).toHaveBeenCalledTimes(1);
    rerender(<StaticMarkdown value="second value" style={{ fontSize: 18 }} />);
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    parse.mockRestore();
  }
});
