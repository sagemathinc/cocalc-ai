import type { Element } from "../whiteboard-editor/types";

// TODO: obviously hard coding this is very much a #v0 thing to do!
export const LEGACY_SLIDE_TOP = -492;

const SLIDE = {
  data: { aspectRatio: "16:9", radius: 0.5 },
  h: 3 * 197,
  w: 3 * 350,
  type: "slide",
  id: "the-slide",
  x: (-3 * 350) / 2,
  y: LEGACY_SLIDE_TOP,
  z: -Infinity,
} as Element;

const fixedElements: { [id: string]: Element } = {
  [SLIDE.id]: SLIDE,
} as const;

export default fixedElements;
