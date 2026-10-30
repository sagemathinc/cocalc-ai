/** @jest-environment jsdom */
import { onFullscreenChange } from "./fullscreen";

it("listens to standard and webkit fullscreen changes until removed", () => {
  const handler = jest.fn();
  const remove = onFullscreenChange(handler);
  document.dispatchEvent(new Event("fullscreenchange"));
  document.dispatchEvent(new Event("webkitfullscreenchange"));
  expect(handler).toHaveBeenCalledTimes(2);
  remove();
  document.dispatchEvent(new Event("fullscreenchange"));
  expect(handler).toHaveBeenCalledTimes(2);
});
