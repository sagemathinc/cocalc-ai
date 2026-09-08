/** @jest-environment jsdom */
import { revealGitReadingViewport } from "./drawer-scroll";

test("scrolls setup away before handing remaining motion to the diff", () => {
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  outer.getBoundingClientRect = () => ({ top: 60 }) as DOMRect;
  inner.getBoundingClientRect = () =>
    ({ top: 560 - outer.scrollTop }) as DOMRect;
  expect(revealGitReadingViewport(outer, inner, 300)).toBe(0);
  expect(outer.scrollTop).toBe(300);
  expect(revealGitReadingViewport(outer, inner, 300)).toBe(100);
  expect(outer.scrollTop).toBe(500);
  expect(revealGitReadingViewport(outer, inner, 300)).toBe(300);
  expect(revealGitReadingViewport(outer, inner, -300)).toBe(-300);
});

test("does not swallow scrolling when the outer container cannot move", () => {
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  Object.defineProperty(outer, "scrollTop", {
    get: () => 0,
    set: () => undefined,
  });
  outer.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  inner.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
  expect(revealGitReadingViewport(outer, inner, 100)).toBe(100);
});
