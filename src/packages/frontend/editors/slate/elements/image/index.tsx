/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useFileContext } from "@cocalc/frontend/lib/file-context";
import { dict } from "@cocalc/util/misc";
import { parseFragmentElement } from "../../markdown-to-slate/util";
import { register, SlateElement } from "../register";

export interface Image extends SlateElement {
  type: "image";
  isInline: true;
  isVoid: true;
  src: string;
  alt?: string;
  title?: string;
  width?: string | number;
  height?: string | number;
}

export function toSlate({ type, children, token }) {
  switch (type) {
    // IMPORTANT: this only gets called with type != 'image'
    // because of explicit code in ./html.tsx.
    case "html_inline":
    case "html_block":
      // token.content will be a string like this:
      //    <img src='https://wstein.org/bella-and-william.jpg' width=200px title='my pup' />
      const elt = parseFragmentElement(token.content);
      const node = {
        type: "image",
        children,
        isInline: true,
        isVoid: true,
        src: elt?.getAttribute("src") ?? "",
        alt: elt?.getAttribute("alt") ?? "",
        title: elt?.getAttribute("title") ?? "",
        width: elt?.getAttribute("width") ?? undefined,
        height: elt?.getAttribute("height") ?? undefined,
      } as any;
      if (type == "html_inline") {
        return node;
      }
      return {
        type: "paragraph",
        children: [{ text: "" }, node, { text: "" }],
      };
    case "image":
      const attrs = dict(token.attrs as any);
      return {
        type: "image",
        children,
        isInline: true,
        isVoid: true,
        src: attrs.src,
        alt: attrs.alt,
        title: attrs.title,
      };
    default:
      throw Error("bug");
  }
}

register({
  slateType: "image",
  toSlate,
  StaticElement: ({ attributes, element }) => {
    const { urlTransform, reloadImages } = useFileContext();
    const node = element as Image;
    const { src, alt, title } = node;
    return (
      <img
        {...attributes}
        src={
          (urlTransform?.(src, "img") ?? src) +
          (reloadImages ? `?${Math.random()}` : "")
        }
        alt={alt}
        title={title}
        style={{
          height: node.height,
          width: node.width,
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "cover",
        }}
      />
    );
  },
});
