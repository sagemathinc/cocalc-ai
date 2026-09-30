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
 * - Track `pending` as the locally-saved values that have not yet been observed
 *   coming back from the remote source.
 * - If the live buffer equals `last` (and there's no pending), adopt remote.
 * - If there are local edits, three-way merge `base`, `local`, and `remote`,
 *   keep `remote` as the baseline until the local edits are saved, and only
 *   overwrite the buffer when the merge differs.
 */
import { diff_main } from "@cocalc/util/dmp";
import { mergeText } from "./string-merge3";

type Getter = () => string;

interface RenderCandidate {
  value: string;
  // The committed value this candidate was derived from.
  base: string;
}
type Setter = (value: string) => void;

export class SimpleInputMerge {
  private last: string;
  private pending: string[] = [];
  // A merged value handed to the editor that it may not have rendered yet.
  // Each candidate records the committed value it was derived from, so a user
  // edit made on top of any candidate rebases only uncommitted changes.
  private requestedLocalUpdate?: {
    latest: RenderCandidate;
    renderCandidates: RenderCandidate[];
  };

  constructor(initialValue: string) {
    this.last = initialValue ?? "";
  }

  // Reset the baseline (e.g., when switching documents).
  public reset(value: string): void {
    // console.log("reset", { value });
    this.last = value ?? "";
    this.pending = [];
    this.requestedLocalUpdate = undefined;
  }

  // Mark that the current value has been saved/committed locally.
  // We wait to advance `last` until the remote echoes this value.
  public noteSaved(value: string): void {
    const next = value ?? "";
    if (next === this.last) {
      this.pending = [];
      return;
    }
    if (this.pending[this.pending.length - 1] === next) {
      return;
    }
    this.pending.push(next);
  }

  // A locally requested save was synchronously reflected by the backing store.
  // Treat the reflected value as the new baseline, and keep it pending so a
  // later persisted echo of the same save is ignored if the user has typed more.
  public noteLocalEcho(value: string): void {
    const next = value ?? "";
    // The backing store now holds the editor's own committed value, so any
    // requested render of an earlier merge is resolved or superseded. Keeping
    // it would let a later remote rebase use one of its stale render
    // candidates as the base and replay already-saved text.
    this.requestedLocalUpdate = undefined;
    this.last = next;
    if (this.pending.length === 0) {
      this.pending = [next];
      return;
    }
    this.pending[this.pending.length - 1] = next;
  }

  // The editor has synchronously rendered the most recently requested merge
  // (it was not deferred). Its contents now derive from that merge's committed
  // base, which is the current baseline, so no render candidate is needed.
  // Editors that render asynchronously should not call this.
  public noteRendered(): void {
    this.requestedLocalUpdate = undefined;
  }

  // Mark that local and remote are known to be in sync.
  public noteApplied(value: string): void {
    this.last = value ?? "";
    const index = this.pending.indexOf(this.last);
    if (index !== -1) {
      this.pending = this.pending.slice(index + 1);
    }
  }

  // Merge an incoming remote value with the current local buffer.
  public handleRemote(opts: {
    remote: string;
    getLocal: Getter;
    applyMerged: Setter;
  }): void {
    const remote = opts.remote ?? "";
    const observedLocal = opts.getLocal() ?? "";
    const { local, base } = this.resolveLocal(observedLocal);
    // console.log("handleRemote", { remote, local, last: this.last });

    // Pending value has been echoed.  IMPORTANT: local may already have
    // advanced beyond pending.  In that case, we must advance baseline first
    // and stop; attempting to rebase from stale `last` can duplicate text.
    if (this.pending.includes(remote)) {
      this.clearSupersededRequest(remote);
      this.noteApplied(remote);
      return;
    }

    // Remote already matches the live local buffer.  This can happen if a
    // local save was observed through another path before `pending` saw the
    // echo.  Rebasing stale `last → local` onto the identical remote would
    // replay the local edit and duplicate inserted text.
    if (remote === local) {
      this.noteApplied(remote);
      return;
    }

    // No local edits since last baseline and no pending: adopt remote directly.
    if (local === this.last && this.pending.length === 0) {
      this.noteApplied(remote);
      if (remote !== local) {
        this.applyMerged(
          opts.applyMerged,
          { value: observedLocal, base },
          { value: remote, base: remote },
        );
      }
      return;
    }

    // Local diverged: rebase local delta onto remote. The baseline becomes the
    // remote value, not the merge: the rebased local edits are not committed
    // yet, and must stay a local delta until their save echoes back. Otherwise
    // a second remote update arriving before that save looks like "no local
    // edits" and is adopted directly, dropping them.
    //
    // Merge with a three-way merge rather than by applying a fuzzy patch of
    // base -> local to remote. When base is older than remote's own base, the
    // local delta repeats changes remote already has; a three-way merge applies
    // those once, and never relocates a deletion onto similar text elsewhere.
    const merged = mergeText({ base, local, remote });
    this.noteApplied(remote);
    if (merged !== local) {
      this.applyMerged(
        opts.applyMerged,
        { value: observedLocal, base },
        { value: merged, base: remote },
      );
    }
  }

  private applyMerged(
    apply: Setter,
    observedLocal: RenderCandidate,
    requested: RenderCandidate,
  ): void {
    const renderCandidates = [
      ...(this.requestedLocalUpdate?.renderCandidates ?? []),
    ];
    for (const candidate of [observedLocal, requested]) {
      if (!renderCandidates.some((c) => c.value === candidate.value)) {
        renderCandidates.push(candidate);
      }
    }
    this.requestedLocalUpdate = { latest: requested, renderCandidates };
    apply(requested.value);
  }

  private resolveLocal(observed: string): { local: string; base: string } {
    const { local, base, settled } = this.inspectLocal(observed);
    if (settled) this.requestedLocalUpdate = undefined;
    return { local, base };
  }

  // Resolve what the observed editor value means relative to committed state,
  // without changing any state. `settled` means a pending render request is
  // resolved (the editor rendered it, or was edited after it).
  private inspectLocal(observed: string): {
    local: string;
    base: string;
    settled: boolean;
  } {
    const requested = this.requestedLocalUpdate;
    if (requested == null) {
      return { local: observed, base: this.last, settled: false };
    }
    if (observed === requested.latest.value) {
      return { local: observed, base: requested.latest.base, settled: true };
    }
    if (requested.renderCandidates.some((c) => c.value === observed)) {
      // The setter has not reached the latest value yet. Treat any known value
      // from the asynchronous render chain as stale UI, not a new local edit.
      return {
        local: requested.latest.value,
        base: requested.latest.base,
        settled: false,
      };
    }

    // The user edited (or the editor canonicalized) while the requested update
    // was being rendered. Decide which value in the render chain the observed
    // value started from, then rebase everything not yet committed relative to
    // that candidate's committed base. Using the candidate itself as the base
    // would treat its uncommitted local edits as committed and drop them. The
    // reconciled baseline is always a candidate.
    const start = [
      { value: this.last, base: this.last },
      ...requested.renderCandidates,
    ].reduce((closest, candidate) =>
      editCost(candidate.value, observed) < editCost(closest.value, observed)
        ? candidate
        : closest,
    );
    return { local: observed, base: start.base, settled: true };
  }

  /**
   * The value to save for the observed editor contents, given the current
   * value of the backing store. Editors can lag behind the store (a remote
   * change deferred while the user types, or not yet rendered); saving the
   * editor contents as-is would revert those changes. This merges the editor's
   * uncommitted edits into the current store value instead. It does not change
   * state; call noteSaved with the returned value when saving it.
   */
  public mergeForSave(opts: { observed: string; current: string }): string {
    const observed = opts.observed ?? "";
    const current = opts.current ?? "";
    const { local, base } = this.inspectLocal(observed);
    if (current === base) return local;
    return mergeText({ base, local, remote: current });
  }

  // Only an echoed save supersedes a render request. Until it echoes, an edit
  // saved from the pre-update UI still needs its original render base when a
  // concurrent remote update arrives.
  private clearSupersededRequest(saved: string): void {
    const requested = this.requestedLocalUpdate;
    if (requested == null) return;
    if (
      saved === requested.latest.value ||
      requested.renderCandidates.some((c) => c.value === saved)
    ) {
      return;
    }
    this.requestedLocalUpdate = undefined;
  }

  public previewMerge(opts: { remote: string; local: string }): {
    merged: string;
    changed: boolean;
  } {
    const remote = opts.remote ?? "";
    const local = opts.local ?? "";

    if (this.pending.includes(remote)) {
      return { merged: local, changed: false };
    }

    if (remote === local) {
      return { merged: local, changed: false };
    }

    if (local === this.last && this.pending.length === 0) {
      const merged = remote;
      return { merged, changed: merged !== local };
    }

    const merged = mergeText({ base: this.last, local, remote });
    return { merged, changed: merged !== local };
  }
}

function editCost(from: string, to: string): number {
  return diff_main(from, to).reduce(
    (total, [operation, value]) =>
      operation === 0 ? total : total + value.length,
    0,
  );
}
