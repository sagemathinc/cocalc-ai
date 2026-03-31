/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { lazy, Suspense } from "react";
import type { Element } from "../types";
import Generic from "../elements/generic";
import Text from "../elements/text-static";
import Note from "../elements/note-static";
import Icon from "../elements/icon";
import Pen from "../elements/pen";
import Frame from "../elements/frame";
import Slide from "../elements/slide";
import Timer from "../elements/timer-static";
import Chat from "../elements/chat-static";

const Code = lazy(() => import("../elements/code/static"));

export interface Props {
  element: Element;
  canvasScale: number;
}

function CodeFallback() {
  return null;
}

export default function ShareRender(props: Props) {
  if (props.element.hide) {
    return null;
  }
  switch (props.element.type) {
    case "text":
      return <Text {...props} />;
    case "note":
      return <Note {...props} />;
    case "icon":
      return <Icon {...props} />;
    case "pen":
      return <Pen {...props} renderStatic />;
    case "code":
      return (
        <Suspense fallback={<CodeFallback />}>
          <Code {...props} />
        </Suspense>
      );
    case "frame":
      return <Frame {...props} />;
    case "slide":
      return <Slide {...props} />;
    case "timer":
      return <Timer {...props} />;
    case "chat":
      return <Chat {...props} />;
    case "selection":
      return null;
    default:
      return <Generic {...props} />;
  }
}
