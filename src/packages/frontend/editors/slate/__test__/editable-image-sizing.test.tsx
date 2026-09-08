import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";

let mockImage: ComponentType<any>;
let mockWidth = 0;
let mockHeight = 0;

jest.mock("../elements/register", () => ({
  register: (definition) => {
    mockImage = definition.Element;
  },
}));
jest.mock("../elements/hooks", () => ({
  useFocused: () => false,
  useSelected: () => false,
  useSlate: () => ({}),
  useProcessLinks: () => ({ current: null }),
}));
jest.mock("../elements/set-element", () => ({
  useSetElement: () => jest.fn(),
}));
jest.mock("../util", () => ({ FOCUSED_COLOR: "blue" }));
jest.mock("../elements/image/index", () => ({
  imageMaxWidth: () => "100%",
}));
jest.mock("@cocalc/frontend/lib/file-context", () => ({
  useFileContext: () => ({}),
}));

import "../elements/image/editable";

const originalDollar = globalThis.$;
beforeEach(() => {
  mockWidth = mockHeight = 0;
  globalThis.$ = (() => ({
    width: () => mockWidth,
    height: () => mockHeight,
  })) as any;
});
afterEach(() => {
  globalThis.$ = originalDollar;
});

test.each([undefined, "320px"])(
  "a hidden/portal image load preserves width %s instead of fixing it to zero",
  (width) => {
    const Image = mockImage;
    render(
      <Image
        attributes={{}}
        element={{
          src: "/image.png",
          alt: "Comment image",
          width,
          height: "200px",
        }}
      >
        <span />
      </Image>,
    );
    const image = screen.getByRole("img", { name: "Comment image" });
    fireEvent.load(image);
    expect(image.style.width).toBe(width ?? "");
    expect(image.parentElement!.style.width).not.toBe("0px");

    mockWidth = 300;
    mockHeight = 180;
    fireEvent.load(image);
    expect(image.style.width).toBe("300px");
    expect(image.parentElement!.style.height).toBe("180px");

    mockWidth = mockHeight = 0;
    fireEvent.load(image);
    expect(image.style.width).toBe("300px");
    expect(image.parentElement!.style.height).toBe("180px");
  },
);
