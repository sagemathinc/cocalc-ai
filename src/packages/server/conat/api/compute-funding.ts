/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  CourseFundingAllocationPreview,
  CourseFundingAllocationStatus,
  CourseFundingCourseRequest,
  CourseFundingGrantSummary,
  CourseFundingPoolSummary,
  CourseFundingPoolChangeDraft,
  CourseFundingPoolChangePreview,
  CourseFundingSources,
  CourseFundingSummary,
  CourseFundingOwnedPools,
} from "@cocalc/conat/hub/api/compute-funding";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
} from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { isBillingAuthorityEnabled } from "@cocalc/server/purchases/billing-authority/config";
import { listClusterBayRegistry } from "@cocalc/server/bay-registry";
import { listCourseFundingSourcesOnBay } from "@cocalc/server/compute/funding/sources";
import { getCourseFundingUsageProjection } from "@cocalc/server/compute/funding/usage-projection";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import { assertCourseAccess } from "@cocalc/server/compute/funding/course-access";
import {
  assertSponsorshipAdmission,
  getSponsorshipAvailability,
} from "@cocalc/server/compute/funding/rollout";
import { withFundingAccountTransaction } from "@cocalc/server/compute/funding/backing";
import { getComputeFundingPolicyInTransaction } from "@cocalc/server/compute/funding/policy";
import {
  proposeCourseFundingAllocation,
  getCourseFundingAllocationStatus,
  proposeCourseFundingPoolChange,
} from "@cocalc/server/compute/funding/approvals";
import {
  normalizeCourseFundingPoolChangeDraft,
  previewCourseFundingPoolChangeInTransaction,
} from "@cocalc/server/compute/funding/pool-changes";
import {
  ComputeFundingError,
  fundingId,
  normalizeCourseFundingDraft,
} from "@cocalc/util/compute-funding";
import type {
  CourseFundingDraft,
  FundingBudget,
} from "@cocalc/util/compute-funding";

type Actor = { account_id?: string };

export { audit } from "@cocalc/server/compute/funding/reconciliation";

export {
  getCourseVmRecommendations,
  setCourseVmRecommendations,
} from "@cocalc/server/compute/funding/course-vm-recommendations";

export async function previewPoolChange(
  opts: Actor & { terms: CourseFundingPoolChangeDraft },
): Promise<CourseFundingPoolChangePreview> {
  const account_id = requireAccount(opts.account_id);
  const terms = normalizeCourseFundingPoolChangeDraft(opts.terms);
  const remote = await remoteHome(account_id);
  if (remote)
    return await remote.computeFundingPreviewPoolChange({ account_id, terms });
  const preview = await withFundingAccountTransaction(
    account_id,
    async (db) =>
      await previewCourseFundingPoolChangeInTransaction(db, {
        payer_account_id: account_id,
        terms,
      }),
  );
  if (preview.requires_course_access) {
    await assertCourseAccess(account_id, terms.course_project_id);
    await assertSponsorshipAdmission();
  }
  return preview;
}

export async function proposePoolChange(
  opts: Actor & { operation_id: string; terms: CourseFundingPoolChangeDraft },
): Promise<CourseFundingAllocationStatus> {
  const account_id = requireAccount(opts.account_id);
  const operation_id = fundingId(opts.operation_id, "Funding operation");
  const terms = normalizeCourseFundingPoolChangeDraft(opts.terms);
  const remote = await remoteHome(account_id);
  if (remote)
    return await remote.computeFundingProposePoolChange({
      account_id,
      operation_id,
      terms,
    });
  // The intent service validates first-time proposals. Replays must recover the
  // original intent even after applying it has changed the pool's version.
  return await proposeCourseFundingPoolChange({
    payer_account_id: account_id,
    operation_id,
    terms,
  });
}

function requireAccount(account_id?: string): string {
  if (!account_id) throw Error("must be signed in");
  return fundingId(account_id, "Account");
}

async function remoteHome(account_id: string) {
  if (isBillingAuthorityEnabled()) return;
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (home_bay_id === getConfiguredBayId()) return;
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  });
}

function budget(row: FundingBudget): FundingBudget {
  return {
    authorized_usd: row.authorized_usd,
    spent_usd: row.spent_usd,
    reserved_usd: row.reserved_usd,
    released_usd: row.released_usd,
  };
}

export async function getCourseSummary(
  opts: CourseFundingCourseRequest & Actor,
): Promise<CourseFundingSummary> {
  const account_id = requireAccount(opts.account_id);
  const course_project_id = fundingId(opts.course_project_id, "Course project");
  const course_instance_id = fundingId(
    opts.course_instance_id,
    "Course instance",
  );
  const remote = await remoteHome(account_id);
  if (remote) {
    return await remote.computeFundingGetCourseSummary({
      account_id,
      course_project_id,
      course_instance_id,
    });
  }
  const result = await readPayerSummary(account_id, {
    course_project_id,
    course_instance_id,
  });
  return {
    ...result,
    pools: result.pools.map(
      ({
        course_project_id: _project,
        course_instance_id: _instance,
        ...pool
      }) => pool,
    ),
  };
}

export async function getOwnedPools(
  opts: Actor = {},
): Promise<CourseFundingOwnedPools> {
  const account_id = requireAccount(opts.account_id);
  const remote = await remoteHome(account_id);
  if (remote) return await remote.computeFundingGetOwnedPools({ account_id });
  return await readPayerSummary(account_id);
}

async function readPayerSummary(
  account_id: string,
  course?: CourseFundingCourseRequest,
): Promise<CourseFundingOwnedPools> {
  // Stored financial ownership survives loss or deletion of the course project.
  const params = [
    account_id,
    course?.course_project_id ?? null,
    course?.course_instance_id ?? null,
  ];
  const sponsorship = await getSponsorshipAvailability();
  return await withFundingAccountTransaction(account_id, async (client) => {
    const { rows: pools } = await client.query<
      Omit<CourseFundingPoolSummary, "grants" | "starts_at" | "ends_at"> & {
        course_project_id: string;
        course_instance_id: string;
        starts_at: Date;
        ends_at: Date;
      }
    >(
      `SELECT id, course_project_id, course_instance_id, state, lane, version, allow_overcommit, authorized_usd::text, spent_usd::text,
         reserved_usd::text, released_usd::text, starts_at, ends_at
       FROM compute_funding_pools
       WHERE payer_account_id=$1 AND ($2::uuid IS NULL OR course_project_id=$2) AND ($3::uuid IS NULL OR course_instance_id=$3)
       ORDER BY starts_at, id LIMIT 1001`,
      params,
    );
    const { rows: grants } = await client.query<
      Omit<CourseFundingGrantSummary, "starts_at" | "ends_at"> & {
        pool_id: string;
        starts_at?: Date;
        ends_at?: Date;
      }
    >(
      `SELECT g.id, g.pool_id, g.beneficiary_account_id, g.state, g.version, g.starts_at, g.ends_at,
         g.authorized_usd::text, g.spent_usd::text, g.reserved_usd::text, g.released_usd::text
       FROM compute_funding_grants g JOIN compute_funding_pools p ON p.id=g.pool_id
       WHERE p.payer_account_id=$1 AND ($2::uuid IS NULL OR p.course_project_id=$2) AND ($3::uuid IS NULL OR p.course_instance_id=$3)
       ORDER BY g.beneficiary_account_id, g.id LIMIT 10001`,
      params,
    );
    if (pools.length > 1000 || grants.length > 10000)
      throw new ComputeFundingError(
        "funding_unavailable",
        "Funding summary exceeds the bounded listing limit; narrow to a course.",
      );
    const byPool = new Map<string, CourseFundingGrantSummary[]>();
    const usage = await getCourseFundingUsageProjection(client, {
      payer_account_id: account_id,
      grant_ids: grants.map((g) => g.id),
    });
    for (const grant of grants) {
      const list = byPool.get(grant.pool_id) ?? [];
      list.push({
        id: grant.id,
        beneficiary_account_id: grant.beneficiary_account_id,
        state: grant.state,
        ...(grant.version === undefined ? {} : { version: grant.version }),
        ...(grant.starts_at
          ? { starts_at: grant.starts_at.toISOString() }
          : {}),
        ...(grant.ends_at ? { ends_at: grant.ends_at.toISOString() } : {}),
        ...budget(grant),
        ...usage.get(grant.id),
      });
      byPool.set(grant.pool_id, list);
    }
    const {
      rows: [clock],
    } = await client.query<{ as_of: Date }>(
      "SELECT clock_timestamp() AS as_of",
    );
    return {
      as_of: clock.as_of.toISOString(),
      sponsorship,
      pools: pools.map((pool) => ({
        id: pool.id,
        course_project_id: pool.course_project_id,
        course_instance_id: pool.course_instance_id,
        state: pool.state,
        lane: pool.lane,
        ...(pool.version === undefined ? {} : { version: pool.version }),
        ...(pool.allow_overcommit === undefined
          ? {}
          : { allow_overcommit: pool.allow_overcommit }),
        ...budget(pool),
        starts_at: pool.starts_at.toISOString(),
        ends_at: pool.ends_at.toISOString(),
        grants: byPool.get(pool.id) ?? [],
      })),
    };
  });
}

export async function listSources(
  opts: Actor & { include_inactive?: boolean } = {},
): Promise<CourseFundingSources> {
  const account_id = requireAccount(opts.account_id);
  if (
    opts.include_inactive !== undefined &&
    typeof opts.include_inactive !== "boolean"
  )
    throw Error("include_inactive must be boolean");
  const filter =
    opts.include_inactive === true ? { include_inactive: true } : {};
  const remote = await remoteHome(account_id);
  if (remote)
    return await remote.computeFundingListSources({ account_id, ...filter });
  if (isBillingAuthorityEnabled()) {
    const { home_bay_id } = await resolveAccountHomeBay({ account_id });
    const snapshot = await listCourseFundingSourcesOnBay({
      beneficiary_account_id: account_id,
      beneficiary_home_bay_id: home_bay_id,
      ...filter,
    });
    return { as_of: snapshot.as_of, sources: snapshot.sources };
  }
  const configured = getConfiguredClusterBayCatalog().map(
    ({ bay_id }) => bay_id,
  );
  const registered = isMultiBayCluster() ? await listClusterBayRegistry() : [];
  if (
    isMultiBayCluster() &&
    !registered.some(({ bay_id }) => bay_id === getConfiguredBayId())
  ) {
    throw new ComputeFundingError(
      "funding_unavailable",
      "The authoritative bay registry is incomplete.",
    );
  }
  const bays = [
    ...new Set([...configured, ...registered.map(({ bay_id }) => bay_id)]),
  ];
  if (bays.length > 32) {
    throw new ComputeFundingError(
      "funding_unavailable",
      "Funding source discovery exceeds the bounded bay limit.",
    );
  }
  const request = {
    beneficiary_account_id: account_id,
    beneficiary_home_bay_id: getConfiguredBayId(),
    ...filter,
  };
  // Never catch and replace a failed bay response with an empty list.
  const snapshots = await mapParallelLimit(
    bays,
    async (bay_id) => {
      if (bay_id === getConfiguredBayId())
        return await listCourseFundingSourcesOnBay(request);
      return await createInterBayAccountLocalClient({
        client: getInterBayFabricClient(),
        dest_bay: bay_id,
        timeout: 5_000,
      }).computeFundingListSourcesOnBay(request);
    },
    4,
  );
  for (const snapshot of snapshots) {
    if (snapshot.payer_home_bay_ids.some((bay_id) => !bays.includes(bay_id))) {
      throw new ComputeFundingError(
        "funding_unavailable",
        "A funding payer home is missing from bay discovery; retry after directory convergence.",
      );
    }
  }
  const sources = snapshots.flatMap((snapshot) => snapshot.sources);
  const identities = new Set<string>();
  for (const source of sources) {
    const key = `${source.pool_id}:${source.grant_id}`;
    if (identities.has(key))
      throw new ComputeFundingError(
        "funding_unavailable",
        "Funding source authority changed during discovery; retry.",
      );
    identities.add(key);
  }
  return {
    // Conservatively report the oldest component snapshot, not fetch completion.
    as_of: snapshots.map((snapshot) => snapshot.as_of).sort()[0],
    sources: sources.sort(
      (a, b) =>
        a.label.localeCompare(b.label) || a.grant_id.localeCompare(b.grant_id),
    ),
  };
}

export async function previewAllocation(
  opts: Actor & { terms: CourseFundingDraft },
): Promise<CourseFundingAllocationPreview> {
  const account_id = requireAccount(opts.account_id);
  const terms = normalizeCourseFundingDraft(opts.terms);
  const remote = await remoteHome(account_id);
  if (remote)
    return await remote.computeFundingPreviewAllocation({ account_id, terms });
  await assertCourseAccess(account_id, terms.course_project_id);
  await assertSponsorshipAdmission();
  const accounts = new Map(
    (
      await getClusterAccountsByIds(
        terms.recipients.map((r) => r.beneficiary_account_id),
      )
    ).map((account) => [account.account_id, account]),
  );
  const recipients = terms.recipients.map(({ beneficiary_account_id }) => {
    const account = accounts.get(beneficiary_account_id);
    if (!account) throw Error("funding recipient account not found");
    return {
      beneficiary_account_id,
      display_name:
        account.display_name ||
        [account.first_name, account.last_name].filter(Boolean).join(" ") ||
        "Student",
      // Account-id lookups must not disclose private email addresses.
    };
  });
  return await withFundingAccountTransaction(account_id, async (client) => {
    const policy = await getComputeFundingPolicyInTransaction(client, {
      payer_account_id: account_id,
      lane: terms.lane,
    });
    const {
      rows: [clock],
    } = await client.query<{ as_of: Date }>(
      "SELECT clock_timestamp() AS as_of",
    );
    if (new Date(terms.ends_at) <= clock.as_of) {
      throw Error("the allocation has already expired");
    }
    return {
      terms,
      available_backing_usd: policy.available_backing_usd,
      recipients,
      as_of: clock.as_of.toISOString(),
    };
  });
}

export async function proposeAllocation(
  opts: Actor & { operation_id: string; terms: CourseFundingDraft },
): Promise<CourseFundingAllocationStatus> {
  const account_id = requireAccount(opts.account_id);
  const operation_id = fundingId(opts.operation_id, "Allocation operation");
  const terms = normalizeCourseFundingDraft(opts.terms);
  const remote = await remoteHome(account_id);
  if (remote)
    return await remote.computeFundingProposeAllocation({
      account_id,
      operation_id,
      terms,
    });
  await assertCourseAccess(account_id, terms.course_project_id);
  await assertSponsorshipAdmission();
  return await proposeCourseFundingAllocation({
    payer_account_id: account_id,
    operation_id,
    terms,
  });
}

export async function getAllocationStatus(
  opts: Actor & { intent_id: string },
): Promise<CourseFundingAllocationStatus> {
  const account_id = requireAccount(opts.account_id);
  const intent_id = fundingId(opts.intent_id, "Allocation intent");
  const remote = await remoteHome(account_id);
  if (remote)
    return await remote.computeFundingGetAllocationStatus({
      account_id,
      intent_id,
    });
  return await getCourseFundingAllocationStatus({
    payer_account_id: account_id,
    intent_id,
  });
}
