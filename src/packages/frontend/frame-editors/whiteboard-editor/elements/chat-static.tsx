import { CSSProperties, FC, ReactNode, useEffect, useRef } from "react";

import { Icon } from "@cocalc/frontend/components/icon";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown-public";
import { cmp } from "@cocalc/util/misc";
import useWheel from "./scroll-wheel";
import { COLORS } from "@cocalc/util/theme";
import { is_valid_uuid_string as isUUID } from "@cocalc/util/misc";
import { getStyle } from "./text-static";
import { Element } from "../types";

export default function ChatStatic({ element }: { element: Element }) {
  return (
    <>
      <Icon
        name={"comment"}
        style={getStyle(element, { fontSize: 24, background: "white" })}
      />
      <div style={getChatStyle(element)}>
        <ChatLog
          Message={Message}
          element={element}
          style={{ flex: 1, overflowY: "auto", background: "white" }}
        />
      </div>
    </>
  );
}

export function getChatStyle(element: Element): CSSProperties {
  return {
    padding: "5px",
    margin: "0 30px 30px 30px",
    background: "white",
    height: `${element.h - 60}px`,
    display: "flex",
    flexDirection: "column",
    border: `3px solid ${element.data?.color ?? "#ccc"}`,
    borderRadius: "5px",
    boxShadow: "1px 5px 7px rgb(33 33 33 / 70%)",
  };
}

export function ChatLog({
  element,
  style,
  Message,
}: {
  element: Element;
  style: CSSProperties;
  Message: FC<{ element: Element; messageId: number | string }>;
}) {
  const divRef = useRef<any>(null);
  useWheel(divRef);

  useEffect(() => {
    const elt = divRef.current as any;
    if (elt) {
      elt.scrollTop = elt.scrollHeight;
    }
  }, [element.data]);
  const v: ReactNode[] = [];
  for (const n of messageNumbers(element)) {
    v.push(<Message key={n} element={element} messageId={n} />);
  }
  return (
    <div ref={divRef} style={style}>
      {v}
    </div>
  );
}

export function lastMessageNumber(element: Element): number {
  let n = -1;
  for (const field in element.data ?? {}) {
    const k = parseInt(field);
    if (!isNaN(k)) {
      n = Math.max(n, k);
    }
  }
  return n;
}

function messageNumbers(element: Element): number[] {
  const v: number[] = [];
  for (const field in element.data ?? {}) {
    if (isUUID(field)) continue;
    const k = parseInt(field);
    if (!isNaN(k)) {
      v.push(k);
    }
  }
  v.sort(cmp);
  return v;
}

// Mutates element removing all messages and drafts:
// delete all the chat messages, e.g., everything in element.data
// with key a number.
export function clearChat(element: Element): void {
  if (element.data == null || element.type != "chat") return;
  for (const field in element.data) {
    if (isUUID(field)) {
      delete element.data[field];
    }
    const k = parseInt(field);
    if (!isNaN(k)) {
      delete element.data[k];
    }
  }
}

export const messageStyle = {
  border: `1px solid ${COLORS.GRAY_L}`,
  borderRadius: "5px",
  margin: "5px 0",
  padding: "5px 15px",
} as CSSProperties;

const commentStyle = {
  display: "flex",
  gap: "12px",
  alignItems: "flex-start",
} as CSSProperties;

const commentAvatarStyle = {
  flex: "0 0 auto",
  minWidth: "32px",
} as CSSProperties;

const commentBodyStyle = {
  flex: 1,
  minWidth: 0,
} as CSSProperties;

const commentMetaStyle = {
  display: "flex",
  gap: "8px",
  alignItems: "baseline",
  flexWrap: "wrap",
  marginBottom: "4px",
} as CSSProperties;

const commentAuthorStyle = {
  color: COLORS.GRAY_D,
  fontWeight: 600,
} as CSSProperties;

const commentDatetimeStyle = {
  color: COLORS.GRAY_M,
  fontSize: "12px",
} as CSSProperties;

export function ChatComment({
  author,
  avatar,
  content,
  datetime,
}: {
  author?: ReactNode;
  avatar?: ReactNode;
  content: ReactNode;
  datetime?: ReactNode;
}) {
  return (
    <div style={commentStyle}>
      {avatar ? <div style={commentAvatarStyle}>{avatar}</div> : undefined}
      <div style={commentBodyStyle}>
        {author || datetime ? (
          <div style={commentMetaStyle}>
            {author ? (
              <span style={commentAuthorStyle}>{author}</span>
            ) : undefined}
            {datetime ? (
              <span style={commentDatetimeStyle}>{datetime}</span>
            ) : undefined}
          </div>
        ) : undefined}
        <div>{content}</div>
      </div>
    </div>
  );
}

export function Message({
  element,
  messageId,
}: {
  element: Element;
  messageId: number | string;
}) {
  const { input, sender_name, time } = element.data?.[messageId] ?? {};
  return (
    <div style={messageStyle}>
      <ChatComment
        author={sender_name}
        content={
          typeof messageId == "number" ? (
            <StaticMarkdown value={input ?? ""} />
          ) : (
            "..."
          )
        }
        datetime={new Date(time).toLocaleString()}
      />
    </div>
  );
}
