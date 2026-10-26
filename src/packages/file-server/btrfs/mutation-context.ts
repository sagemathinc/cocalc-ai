import { AsyncLocalStorage } from "node:async_hooks";

export type BtrfsMutationPriority =
  | "lifecycle"
  | "interactive"
  | "scheduled"
  | "scavenger";

export type BtrfsMutationContext = {
  operation_id?: string;
  project_id?: string;
  priority?: BtrfsMutationPriority;
  operation_class?: string;
  cgroup_path?: string;
  checkpointable?: boolean;
  starvation_override?: boolean;
  yield_requested?: boolean;
  lifecycle_backlog?: number;
  // A short, indivisible Btrfs transaction currently owns the filesystem
  // mutation lock. Background discovery stays in the maintenance cgroup, but
  // the transaction itself must inherit foreground I/O priority so it cannot
  // hold filesystem-wide resources while deeply throttled.
  mutation_lock_held?: boolean;
  // Counts the mutations that passed their final eligibility check in this
  // context (shared by nested contexts), so a caller can tell an operation
  // refused before it changed anything from one refused partway through.
  mutations?: { count: number };
};

const mutationContext = new AsyncLocalStorage<BtrfsMutationContext>();

export function getBtrfsMutationContext(): BtrfsMutationContext {
  return mutationContext.getStore() ?? {};
}

export function effectiveBtrfsMutationContext(
  context?: BtrfsMutationContext,
): BtrfsMutationContext {
  const current = getBtrfsMutationContext();
  return {
    ...current,
    ...(context ?? {}),
    priority: context?.priority ?? current.priority ?? "interactive",
  };
}

export async function withBtrfsMutationContext<T>(
  context: BtrfsMutationContext,
  run: () => Promise<T>,
): Promise<T> {
  return await mutationContext.run(effectiveBtrfsMutationContext(context), run);
}

export function isBackgroundBtrfsMutation(): boolean {
  const context = getBtrfsMutationContext();
  return (
    context.mutation_lock_held !== true &&
    (context.priority === "scheduled" || context.priority === "scavenger")
  );
}

// A mutation passed its final eligibility check and is about to run.
export function noteBtrfsMutation(): void {
  const counter = getBtrfsMutationContext().mutations;
  if (counter != null) counter.count += 1;
}
