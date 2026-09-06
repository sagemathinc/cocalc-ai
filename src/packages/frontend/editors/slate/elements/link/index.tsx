/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { Text } from "slate";
import { useFileContext } from "@cocalc/frontend/lib/file-context";
import { isSafeHtmlUrl } from "@cocalc/frontend/components/sanitize-html";
import { dict } from "@cocalc/util/misc";
import { register, SlateElement } from "../register";

export const LINK_STYLE: CSSProperties = {
  backgroundColor: `var(--cocalc-slate-link-chip-bg, ${UI_COLORS.surface})`,
  border: "1px solid var(--cocalc-slate-link-chip-border, transparent)",
  padding: "1px",
  margin: "-1px", // so the position isn't changed; important when background is white so doesn't look weird.
  borderRadius: "2px",
} as const;

export interface Link extends SlateElement {
  type: "link";
  isInline: true;
  url?: string;
  title?: string;
}

function isSafeInternalFileUrl(value: string): boolean {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol === "sandbox:") {
      return url.host === "" && url.pathname.startsWith("/");
    }
    if (
      url.protocol !== "cocalc-file:" ||
      url.hostname !== "open" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return false;
    }
    const path = url.searchParams.get("path") ?? "";
    return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
  } catch {
    return false;
  }
}

function isSafeSlateLinkUrl(value: string): boolean {
  return isSafeHtmlUrl(value) || isSafeInternalFileUrl(value);
}

register({
  slateType: "link",

  StaticElement: ({ attributes, children, element }) => {
    const node = element as Link;
    let { url, title } = node;
    const { AnchorTagComponent, urlTransform, anchorStyle, noSanitize } =
      useFileContext();
    const style: CSSProperties = { ...LINK_STYLE, ...anchorStyle };
    const transformedUrl =
      url == null ? undefined : (urlTransform?.(url, "a") ?? url);
    const safeUrl =
      transformedUrl == null || noSanitize || isSafeSlateLinkUrl(transformedUrl)
        ? transformedUrl
        : undefined;
    if (AnchorTagComponent != null) {
      return (
        <AnchorTagComponent
          {...attributes}
          href={safeUrl}
          title={title}
          style={style}
        >
          {children}
        </AnchorTagComponent>
      );
    }
    let props;
    if (safeUrl != null) {
      const isExternal = safeUrl.includes("://");
      props = {
        href: safeUrl,
        target: isExternal ? "_blank" : undefined,
        rel: isExternal ? "noopener" : undefined,
      };
    }
    return (
      <a {...attributes} {...props} title={title} style={style}>
        {children}
        {isBlank(element) && <span contentEditable={false}>(blank link)</span>}
      </a>
    );
  },

  toSlate: ({ type, children, state }) => {
    const attrs = dict(state.attrs as any);
    return {
      type,
      children,
      isInline: true,
      url: attrs.href,
      title: attrs.title,
    };
  },
});

function isBlank(element): boolean {
  return (
    element.children.length == 1 &&
    Text.isText(element.children[0]) &&
    !element.children[0].text.trim()
  );
}
