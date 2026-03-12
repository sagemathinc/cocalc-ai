import { CSS } from "@cocalc/frontend/app-framework";
import { useBottomScroller } from "@cocalc/frontend/app-framework/use-bottom-scroller";
import { Paragraph } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { COLORS } from "@cocalc/util/theme";
import type { RefObject } from "react";

const STYLE = {
  border: "1px solid lightgrey",
  borderRadius: "5px",
  margin: "5px 0",
  padding: "10px",
  overflowY: "auto",
  maxHeight: "150px",
  fontSize: "85%",
  fontFamily: "monospace",
  whiteSpace: "pre-wrap",
  color: COLORS.GRAY_M,
} as const;

interface Props {
  input: React.JSX.Element | string;
  style?: CSS;
  scrollBottom?: boolean;
  rawText?: boolean;
}

export function RawPrompt({
  input,
  style: style0,
  scrollBottom = false,
  rawText = false,
}: Props) {
  const ref = useBottomScroller<HTMLElement>(scrollBottom, input);
  const style = { ...STYLE, ...style0 };
  if (typeof input == "string" && !rawText) {
    return (
      <div ref={ref as RefObject<HTMLDivElement>} style={style}>
        <StaticMarkdown value={input} />
      </div>
    );
  } else {
    return (
      <Paragraph ref={ref as RefObject<HTMLParagraphElement>} style={style}>
        {input}
      </Paragraph>
    );
  }
}
