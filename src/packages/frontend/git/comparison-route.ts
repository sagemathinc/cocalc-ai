import type {
  ImmutableReviewTarget,
  RepositoryContext,
} from "@cocalc/frontend/components/diff-viewer/review-model";
import type { GitComparisonRoute } from "./review-route";
import type { GitReadService } from "./read-service";

export function comparisonRoute(
  target: ImmutableReviewTarget,
): GitComparisonRoute {
  const commonDirectory = target.repository.commonDirectory;
  return target.kind === "commit"
    ? {
        commonDirectory,
        mode: "parent",
        head: target.commit,
        parentIndex: target.parentIndex,
      }
    : {
        commonDirectory,
        mode: target.mode,
        head: target.head,
        base: target.requestedBase,
      };
}

export async function restoreComparisonRoute(
  reader: Pick<
    GitReadService,
    "invalidateDiscovery" | "discover" | "pinCommit" | "compare"
  >,
  repository: RepositoryContext,
  route: GitComparisonRoute,
): Promise<ImmutableReviewTarget> {
  reader.invalidateDiscovery(repository.projectId);
  const fresh = await reader.discover(repository.projectId, repository.locator);
  if (
    fresh.repository.commonDirectory !== route.commonDirectory ||
    fresh.repository.commonDirectory !== repository.commonDirectory
  ) {
    throw Error("The comparison link belongs to a different repository");
  }
  return route.mode === "parent"
    ? reader.pinCommit(fresh.repository, route.head, route.parentIndex)
    : reader.compare(fresh.repository, route.base, route.head, route.mode);
}
