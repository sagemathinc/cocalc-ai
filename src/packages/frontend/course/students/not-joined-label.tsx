/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { FormattedMessage } from "react-intl";

import { UI_COLORS } from "@cocalc/util/appearance-palette";

// Shown in place of "last active" for a student not yet linked to an account.
// We cannot say whether the invited address already has an account (that
// would leak account existence), only whether a course invitation is still
// waiting to be accepted.
export function StudentNotJoinedLabel({
  invitePending,
}: {
  invitePending: boolean;
}) {
  return (
    <span style={{ color: UI_COLORS.secondary }}>
      {invitePending ? (
        <FormattedMessage
          id="course.students-panel-student.last_active.invite_pending"
          defaultMessage="(invitation not accepted yet)"
          description="The student was invited to the online course but has not accepted the invitation"
        />
      ) : (
        <FormattedMessage
          id="course.students-panel-student.last_active.not_joined"
          defaultMessage="(has not joined yet)"
          description="The student in the online course is not linked to a CoCalc account yet"
        />
      )}
    </span>
  );
}
