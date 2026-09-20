import { ErrorDisplay } from "@cocalc/frontend/components/error-display";

export function ExplorerError({
  error,
  onClose,
}: {
  error: string | object;
  onClose: () => void;
}) {
  return (
    // Keep the alert in flow and leave the upper-right panel toggle unobscured.
    <div style={{ paddingRight: 48, minWidth: 0, marginBottom: 8 }}>
      <ErrorDisplay
        error={error}
        onClose={onClose}
        style={{ maxHeight: 150 }}
        body_style={{ overflowWrap: "anywhere" }}
      />
    </div>
  );
}
