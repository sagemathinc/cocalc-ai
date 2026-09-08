import { useId, useState } from "react";
import { Button, Input } from "antd";

// Recovery is deliberately separate from inline comments and agent submission.
export function RecoveredNotes({
  versions,
  current,
}: {
  versions?: string[];
  current: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const alternatives = [...new Set(versions ?? [])].filter(
    (x) => x !== current,
  );
  if (!alternatives.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <Button
        size="small"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        Recovered private note versions ({alternatives.length})
      </Button>
      <div id={id} hidden={!open}>
        <p>
          Different saved and local notes were retained. Copy text from these
          versions into the private note editor to reconcile them. These
          versions are not sent to the agent.
        </p>
        {alternatives.map((note, index) => (
          <Input.TextArea
            key={index}
            aria-label={`Recovered private note version ${index + 1}`}
            value={note}
            placeholder="Empty note"
            readOnly
            rows={4}
            style={{ marginBottom: 8 }}
          />
        ))}
      </div>
    </div>
  );
}
