export function AgentsSidebarResizeHandle({
  width,
  minWidth,
  maxWidth,
  onResize,
}: {
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
}) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize Agents panel"
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? width - 20
            : event.key === "ArrowRight"
              ? width + 20
              : event.key === "Home"
                ? minWidth
                : event.key === "End"
                  ? maxWidth
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onResize(Math.max(minWidth, Math.min(maxWidth, next)));
      }}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
