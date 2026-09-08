import { useState } from "react";
import type { ReactNode } from "react";
import {
  readGitReviewDetailsPreference,
  persistGitReviewDetailsPreference,
} from "./drawer-storage";

export function CommitDetailsDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(readGitReviewDetailsPreference);
  return (
    <details
      className="git-review-disclosure"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        persistGitReviewDetailsPreference(next);
      }}
    >
      <summary>Commit details</summary>
      {children}
    </details>
  );
}
