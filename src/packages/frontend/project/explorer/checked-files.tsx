import { useProjectContext } from "@cocalc/frontend/project/context";
import { useRedux } from "@cocalc/frontend/app-framework";
import { PRE_STYLE } from "./action-box";
import { path_split } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

export default function CheckedFiles({
  variant = "block",
  maxVisible,
}: {
  variant?: "block" | "compact";
  maxVisible?: number;
}) {
  const { actions } = useProjectContext();
  const checked_files = useRedux(["checked_files"], actions?.project_id ?? "");
  const names = checked_files
    ?.toArray()
    .map((name) => path_split(name).tail)
    .filter(Boolean);

  if (!names?.length) {
    return null;
  }

  if (variant === "compact") {
    const visible = maxVisible == null ? names : names.slice(0, maxVisible);
    const remaining =
      maxVisible == null ? 0 : Math.max(0, names.length - visible.length);
    return (
      <div
        style={{
          fontSize: "13px",
          color: COLORS.GRAY_M,
          lineHeight: 1.5,
          marginBottom: "12px",
        }}
      >
        <div style={{ fontWeight: 500, color: COLORS.GRAY_D }}>
          {names.length === 1
            ? "Selected item"
            : `Selected items (${names.length})`}
        </div>
        <div>{visible.join(", ")}</div>
        {remaining > 0 && <div>+ {remaining} more</div>}
      </div>
    );
  }

  return (
    <pre style={PRE_STYLE}>
      {names.map((name) => (
        <div key={name}>{name}</div>
      ))}
    </pre>
  );
}
