/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

export function featureAppPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

export function FeatureImage({ alt, src }: { alt: string; src?: string }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      style={{
        width: "100%",
        aspectRatio: "16 / 9",
        objectFit: "cover",
        borderRadius: 14,
      }}
    />
  );
}

export function BulletList({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 20 }}>
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 8 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

export function LinkButton({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <Button type="link" href={href} style={{ paddingInline: 0 }}>
      {children}
    </Button>
  );
}
