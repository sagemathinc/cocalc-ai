import type { PoolClient } from "@cocalc/database/pool";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import type { CourseFundingPoolChangeDraft } from "@cocalc/conat/hub/api/compute-funding";
import { withFundingAccountTransaction } from "./backing";
import { previewCourseFundingPoolChangeInTransaction } from "./pool-changes";
import { assertCourseAccess } from "./course-access";
import {
  assertSponsorshipAdmission,
  assertSponsorshipAdmissionInTransaction,
} from "./rollout";

/** No network calls under the money lock. Review again at approval time; a
 * pending intent does not preserve withdrawn project access or rollout safety.
 */
export async function prepareSponsorshipApproval(
  payer: string,
  terms: CourseFundingDraft | CourseFundingPoolChangeDraft,
): Promise<(db: PoolClient) => Promise<void>> {
  const expanded =
    !("action" in terms) ||
    (
      await withFundingAccountTransaction(payer, (db) =>
        previewCourseFundingPoolChangeInTransaction(db, {
          payer_account_id: payer,
          terms,
        }),
      )
    ).requires_course_access;
  if (!expanded) return async () => {};
  await assertCourseAccess(payer, terms.course_project_id);
  const proof = await assertSponsorshipAdmission();
  return async (db) => await assertSponsorshipAdmissionInTransaction(db, proof);
}
