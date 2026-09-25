import React from "react";
const { act, create } = require("react-test-renderer");
import { AgentAvatar } from "./avatar";

jest.mock("@cocalc/assets/cocalc-icons-font/cocalc-icons.ttf", () => "font");
jest.mock("expo-font", () => ({ useFonts: () => [true] }));
jest.mock("@react-native-vector-icons/ant-design", () => ({
  AntDesign: "AntDesign",
}));
jest.mock("../ui/palette", () => ({
  usePalette: () => ({ border: "#777", inset: "#eee", text: "#111" }),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it("renders a custom theme image using the same blob URL as the web app", async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      <AgentAvatar
        name="Research"
        siteUrl="https://cocalc.ai/"
        appearance={{
          thread_image: " 11111111-1111-4111-8111-111111111111 ",
          thread_color: "#123456",
        }}
      />,
    );
  });
  expect(renderer.root.findByType("Image").props.source.uri).toBe(
    "https://cocalc.ai/blobs/theme-image.png?uuid=11111111-1111-4111-8111-111111111111",
  );
  await act(async () => renderer.root.findByType("Image").props.onError());
  expect(renderer.root.findAllByType("Image")).toHaveLength(0);
  expect(renderer.root.findByType("Text").props.children).toBe("R");
  await act(async () => renderer.unmount());
});
