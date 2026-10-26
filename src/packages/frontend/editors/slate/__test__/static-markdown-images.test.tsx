/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import StaticMarkdown from "../static-markdown";
import { imageMaxWidth } from "../elements/image";
import { FileContext } from "@cocalc/frontend/lib/file-context";

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

  it("with an image box height, unsized images keep one height loaded or not", () => {
    render(
      <FileContext.Provider value={{ imageBoxHeight: 320 }}>
        <StaticMarkdown
          value={[
            "![Screenshot](/blobs/shot.png?uuid=shot)",
            '<img src="/blobs/sized.png?uuid=sized" width="200" alt="Sized" />',
          ].join("\n\n")}
        />
      </FileContext.Provider>,
    );
    const shot = screen.getByAltText("Screenshot");
    expect(shot.style.height).toBe("320px");
    expect(shot.style.objectFit).toBe("scale-down");
    // An image with a size of its own keeps it.
    const sized = screen.getByAltText("Sized");
    expect(sized.style.height).not.toBe("320px");
  });

  it("without one, images are as before", () => {
    render(<StaticMarkdown value="![Screenshot](/blobs/shot.png?uuid=shot)" />);
    expect(screen.getByAltText("Screenshot").style.height).toBe("");
  });

  it("in an image box, generated images keep their width cap", () => {
    render(
      <FileContext.Provider value={{ imageBoxHeight: 320 }}>
        <StaticMarkdown value="![Generated image](/blobs/g.png?uuid=g)" />
      </FileContext.Provider>,
    );
    const image = screen.getByAltText("Generated image");
    expect(image.style.height).toBe("320px");
    expect(image.style.maxWidth).toBe("480px");
  });
});
