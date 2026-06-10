// See comment in note-mostly-static for why this exists.

import { CSSProperties } from "react";
import { Element } from "../types";
import { getFullStyle, PLACEHOLDER } from "./text-static";
import MostlyStaticMarkdown from "@cocalc/frontend/editors/slate/mostly-static-markdown";
import { useFrameContext } from "../hooks";
import { legacyEscapedMathDelimitersToText } from "../document-schema";

interface Props {
  element: Element;
  readOnly?: boolean;
  style?: CSSProperties;
  legacyMarkdown?: boolean;
}

export default function Text({
  element,
  readOnly,
  style,
  legacyMarkdown,
}: Props) {
  const { actions } = useFrameContext();
  const val = element.str?.trim();
  const isEmpty = !val || val == element.data?.initStr?.trim();
  const value = legacyMarkdown
    ? legacyEscapedMathDelimitersToText(element.str ?? "")
    : (element.str ?? "");
  return (
    <MostlyStaticMarkdown
      value={isEmpty ? (element.data?.placeholder ?? PLACEHOLDER) : value}
      style={{ ...getFullStyle(element, isEmpty), ...style }}
      onChange={
        readOnly || actions == null
          ? undefined
          : (str) => {
              actions.setElement({
                obj: { id: element.id, str },
                commit: true,
              });
            }
      }
    />
  );
}
