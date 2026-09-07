export function WorktreeAgentConsent({
  path,
  checked,
  disabled,
  onChange,
}: {
  path: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label style={{ display: "block", margin: "8px 0" }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />{" "}
      Send agent feedback in {path} (a new thread is created if the current
      thread uses another directory)
    </label>
  );
}
