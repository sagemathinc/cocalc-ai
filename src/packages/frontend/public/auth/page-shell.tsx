import type { CSSProperties, ReactNode } from "react";
import { COLORS } from "@cocalc/util/theme";

const PAGE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100%",
  padding: "40px 16px",
  background: COLORS.GRAY_LLL,
} as const;

const CARD_STYLE: CSSProperties = {
  width: "min(480px, 96vw)",
  borderRadius: "12px",
  border: `1px solid ${COLORS.GRAY_LL}`,
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.08)",
} as const;

const TITLE_STYLE: CSSProperties = {
  marginBottom: "12px",
} as const;

interface PublicAuthPageShellProps {
  children: ReactNode;
  subtitle?: ReactNode;
  title: ReactNode;
}

export default function PublicAuthPageShell({
  children,
  subtitle,
  title,
}: PublicAuthPageShellProps) {
  return (
    <div style={PAGE_STYLE}>
      <div style={{ ...CARD_STYLE, background: "white", padding: "32px" }}>
        <h1
          style={{
            ...TITLE_STYLE,
            color: COLORS.GRAY_D,
            fontSize: "28px",
            lineHeight: 1.2,
          }}
        >
          {title}
        </h1>
        {subtitle ? (
          <div style={{ color: COLORS.GRAY, fontSize: "15px" }}>{subtitle}</div>
        ) : null}
        <div style={{ marginTop: "24px" }}>{children}</div>
      </div>
    </div>
  );
}
