/*
 * Lightweight merge helper for single-value inputs (textarea, markdown editor, etc.)
 * that need to preserve local edits when remote updates arrive.
 *
 * Usage:
 *   const merger = new SimpleInputMerge(initialValue);
 *   // on remote change (newValue):
 *   merger.handleRemote({
 *     remote: newValue,
 *     getLocal: () => currentInputValue,
 *     applyMerged: (v) => setInputValue(v),
 *   });
 *   // when a value is saved/committed:
 *   merger.noteSaved(currentInputValue);
 *
 * Algorithm:
 * - Track `last` as the reconciled baseline.
 * - Track `pending` as the most recent locally-saved value that has not yet been
 *   observed coming back from the remote source.
 * - If the live buffer equals `last` (and there's no pending), adopt remote.
 * - If there are local edits, compute a patch from `last → local`, apply it to
 *   `remote`, set `last` to the merged value, and only overwrite the buffer when
 *   it differs.
 */
import { applyPatch, makePatch } from "patchflow";

type Getter = () => string;
type Setter = (value: string) => void;

export class SimpleInputMerge {
  private last: string;
  private pending: string | null = null;

  constructor(initialValue: string) {
    this.last = initialValue ?? "";
  }

  // Reset the baseline (e.g., when switching documents).
  public reset(value: string): void {
    // console.log("reset", { value });
    this.last = value ?? "";
    this.pending = null;
  }

  // Mark that the current value has been saved/committed locally.
  // We wait to advance `last` until the remote echoes this value.
  public noteSaved(value: string): void {
    const next = value ?? "";
    if (next === this.last) {
      this.pending = null;
      return;
    }
    this.pending = next;
  }

  // Mark that local and remote are known to be in sync.
  public noteApplied(value: string): void {
    this.last = value ?? "";
    this.pending = null;
  }

  // Merge an incoming remote value with the current local buffer.
  public handleRemote(opts: {
    remote: string;
    getLocal: Getter;
    applyMerged: Setter;
  }): void {
    const remote = opts.remote ?? "";
    const local = opts.getLocal() ?? "";
    // console.log("handleRemote", { remote, local, last: this.last });

    // Pending value has been echoed and local hasn't changed beyond it.
    if (this.pending != null && remote === this.pending && local === this.pending) {
      this.noteApplied(remote);
      return;
    }

    // No local edits since last baseline and no pending: adopt remote directly.
    if (local === this.last && this.pending == null) {
      this.noteApplied(remote);
      if (remote !== local) {
        opts.applyMerged(remote);
      }
      return;
    }

    // Local diverged: rebase local delta onto remote.
    const delta = makePatch(this.last, local);
    const [merged] = applyPatch(delta, remote);
    this.noteApplied(merged);
    if (merged !== local) {
      opts.applyMerged(merged);
    }
  }

  public previewMerge(opts: { remote: string; local: string }): {
    merged: string;
    changed: boolean;
  } {
    const remote = opts.remote ?? "";
    const local = opts.local ?? "";

    if (this.pending != null && remote === this.pending && local === this.pending) {
      return { merged: remote, changed: false };
    }

    if (local === this.last && this.pending == null) {
      const merged = remote;
      return { merged, changed: merged !== local };
    }

    const delta = makePatch(this.last, local);
    const [merged] = applyPatch(delta, remote);
    return { merged, changed: merged !== local };
  }
}
