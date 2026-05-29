/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import StaticMarkdown from "../static-markdown";
import { imageMaxWidth } from "../elements/image";

describe("StaticMarkdown images", () => {
  it("caps generated image markdown without shrinking ordinary images", () => {
    render(
      <StaticMarkdown
        value={[
          "![Generated image](/blobs/generated.png?uuid=generated)",
          "![Ordinary image](/blobs/ordinary.png?uuid=ordinary)",
        ].join("\n\n")}
      />,
    );

    const generated = screen.getByAltText("Generated image");
    const ordinary = screen.getByAltText("Ordinary image");

    expect(generated.style.maxWidth).toBe("480px");
    expect(generated.style.objectFit).toBe("contain");
    expect(ordinary.style.maxWidth).toBe("100%");
  });

  it("uses the generated image cap in all Slate image renderers", () => {
    expect(imageMaxWidth({ alt: "Generated image" })).toBe(480);
    expect(imageMaxWidth({ alt: "Generated image", width: "100%" })).toBe(480);
    expect(imageMaxWidth({ alt: "Generated image", width: 320 })).toBe("100%");
    expect(imageMaxWidth({ alt: "Generated image", width: "320px" })).toBe(
      "100%",
    );
    expect(imageMaxWidth({ alt: "Ordinary image" })).toBe("100%");
  });
});
