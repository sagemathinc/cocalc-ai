# Membership-Based Student Pay Plan

Date: 2026-05-10

## Goal

Replace the old course-date-and-project-quota student-pay model with a membership-based course access model.

The instructor chooses a course-eligible membership tier. Students either buy that tier themselves, receive it from an instructor-paid course seat package, or already have an equal-or-higher priority membership. Course access is then a membership entitlement check, not a per-project license check.

The student-facing concept should be "course access pass" or "student course membership". The backend can still use membership tiers, grants, and packages.

## Current Implementation Inventory

### Old Student-Pay Path Still Exists

The old model is still present and should be replaced.

- `src/packages/util/db-schema/projects.ts`
  - `CourseInfo` has `pay`, `paid`, `purchase_id`, and `payInfo?: PurchaseInfo`.
  - The schema description still says `payInfo` specifies course fee parameters.

- `src/packages/util/purchases/quota/student-pay.ts`
  - `DEFAULT_PURCHASE_INFO` encodes the old quota purchase model: start/end dates, RAM, CPU, disk, member host, uptime, etc.

- `src/packages/frontend/course/configuration/student-pay.tsx`
  - Instructor UI still says "Start and end dates and upgrades...".
  - Uses `LicenseEditor`, `compute_cost`, `payInfo`, `pay`, `student_pay`, and `institute_pay`.

- `src/packages/server/purchases/student-pay.ts`
  - Creates a `student-pay` purchase from `CourseInfo.payInfo`.
  - Requires `payInfo.start` and `payInfo.end`.
  - Creates a `membership_grants` row with hard-coded `membership_class: "student"`.
  - Marks the student project `course.paid`.
  - Updates `usage_account_id` to the student account.

- `src/packages/frontend/purchases/student-pay/*`
  - Student project banner/modal is driven by `course.pay`, `course.paid`, and `course.payInfo`.
  - It supports old "transfer course fee" behavior by comparing course dates and cost.

- `src/packages/server/purchases/stripe/create-payment-intent.ts`
  - Student-pay payment intents use metadata `{ project_id }`.

- `src/packages/server/purchases/stripe/process-payment-intents.ts`
  - `STUDENT_PAY` payment intent processing calls `studentPay({ account_id, project_id, amount, credit_id })`.

### Instructor-Paid Course Seats Mostly Exist

The newer membership-package path is already useful and should be reused.

- `src/packages/conat/hub/api/purchases.ts`
  - Defines `MembershipPackageKind = "course" | "team" | "site"`.
  - Exposes quote, purchase, list, assign, revoke, claim APIs for membership packages.

- `src/packages/server/membership/packages.ts`
  - `grantSourceForKind("course")` returns `course-seat`.
  - Course package assignment creates a membership grant for the target student.
  - Course package assignment can update student project `usage_account_id`.
  - Multi-bay routing exists for grant sync and project usage side effects.
  - Current `getCourseSeatQuote` still depends on `CourseInfo.payInfo`, start/end dates, quota cost, and hard-coded `membership_class: "student"`.

- `src/packages/server/membership/packages.test.ts`
  - Tests course-seat assignment, reserved email claim, project usage attribution, and multi-bay routing.

- `src/packages/frontend/course/configuration/institute-pay.tsx`
  - Instructor can buy course seats and add seats.
  - Current UI still requires old "course fee and upgrades" configuration first.
  - Current quote path still derives seat price and term from old course `payInfo`.

- `src/packages/frontend/course/students/students-panel-student.tsx`
  - Instructor can assign/revoke institute-paid course seats to student accounts.

- `src/packages/frontend/course/membership-packages.ts`
  - Frontend helpers identify course membership packages by `metadata.course_project_id`.

### Membership Tier Model Exists But Needs Course Fields

- `src/packages/util/db-schema/membership-tiers.ts`
  - Tiers currently have `store_visible`, prices, priority, project defaults, AI limits, features, usage limits, disabled, notes.
  - There is no course/student-specific visibility flag.
  - There is no one-time 4-month course price field.

- `src/packages/util/membership-tier-templates.ts`
  - The `student` tier exists and is not store-visible.
  - Current `student` price is monthly/yearly (`$8/month`, `$72/year`), not the desired `$25/4 months`.

## Product Model

### Course Requirement

Each course can declare:

- `student_pay_enabled`: students are responsible for buying access.
- `instructor_pay_enabled`: instructor/institution buys seats and assigns them.
- `site_license_enabled`: use a matching site license when the instructor's verified email domain is covered.
- `required_membership_class`: tier id required by the course.
- `student_grace_days`: default `14`.
- `student_access_pass_duration_days`: default `122`.
- `course_ends_at`: optional course end date used only to explain whether an existing expiring membership covers the whole class. It must not affect price.

The final field names should be concise and live in course settings / `CourseInfo`, but the user-facing language should say "course access pass", not "membership class".

### Student Access Rule

A student can use a course project if any of these is true:

- The course does not require a student course membership.
- The student is within the course grace period.
- The student's effective membership priority is greater than or equal to the required course tier priority.
- The student has an active course-seat grant from an instructor-paid package for the required tier.
- The student has an active direct student-course purchase grant for the required tier.
- The course uses a site license, and the student has claimed or can claim a site-license membership with sufficient priority using a verified matching email domain.

This intentionally solves section changes and multiple concurrent classes. If two courses require the same student tier, or the second course requires a lower-priority tier, one active purchase/grant is enough.

### Grace Period

Default: 14 days.

Recommended anchor:

- For existing student project records, use `course.student_membership_required_at` if present.
- Otherwise use the later of:
  - when the course requirement was enabled,
  - when the student project was created/linked to the course.

Reason: the old "course start date" model is intentionally being removed, but students still need predictable access at the beginning. A per-student deadline is more robust for late adds and section changes.

Open decision: if instructors strongly expect a single course-wide deadline, add an optional `student_pay_deadline` override later. Do not make that part of the first implementation unless necessary.

### Pricing

Course student tiers should be one-time purchases:

- Default duration: 4 months / 122 days.
- Default template: `student` tier, `$25` for 4 months.
- No automatic renewal.
- No pricing based on course dates, project quotas, CPU, RAM, disk, uptime, or number of projects.

The membership tier should carry the course price/duration rather than deriving it from course settings.

Recommended tier fields:

- `course_store_visible: boolean`
- `course_price: number`
- `course_duration_days: number`

Alternative if we want to avoid adding columns:

- Store these in `features.course_student = true`, `features.course_price`, and `features.course_duration_days`.

Recommendation: use top-level columns because this is admin-edited product configuration, not an arbitrary runtime feature flag. It also makes querying course-eligible tiers simple and avoids hidden JSON semantics in admin UI.

### Tier Eligibility

Course-eligible tiers:

- Do not have to be visible in the normal store.
- Should be selectable in course configuration.
- Should be usable for both student-pay and instructor-pay seats.
- Should be disabled if the tier is disabled.

Normal memberships with equal-or-higher priority should satisfy course access even if they are not course-store-visible. This is important for users who already pay for a stronger tier.

## Backend Design

### Data Model Changes

Add fields to `membership_tiers`:

- `course_store_visible boolean not null default false`
- `course_price numeric(20,10)`
- `course_duration_days integer`

Update:

- `src/packages/util/db-schema/membership-tiers.ts`
- generated/types as needed
- admin membership tier UI
- `src/packages/util/membership-tier-templates.ts`

Template update:

- `student.store_visible = false`
- `student.course_store_visible = true`
- `student.course_price = 25`
- `student.course_duration_days = 122`

Course config should delete the old `payInfo` model instead of keeping a compatibility path. This is greenfield, and keeping old quota/date purchase state around creates confusing dead code. Add fields to course settings and `CourseInfo`, for example:

```ts
student_pay?: boolean;
institute_pay?: boolean;
site_license_pay?: boolean;
required_membership_class?: string;
student_membership_required_at?: string;
student_membership_grace_days?: number;
course_ends_at?: string;
```

Remove old `payInfo`, `paid`, `purchase_id`, quota-derived course fee, and course-fee transfer writes from the active model rather than retaining fallback reads.

### Access Resolver

Add a dedicated resolver instead of scattering checks across frontend project store logic.

Suggested module:

- `src/packages/server/courses/student-access.ts`

Suggested API:

```ts
type CourseStudentAccessStatus =
  | { status: "not-required" }
  | {
      status: "active";
      source: "membership" | "course-seat" | "student-course-purchase";
      membership_class: string;
    }
  | { status: "grace"; deadline: Date; required_membership_class: string }
  | { status: "blocked"; deadline: Date; required_membership_class: string };
```

The resolver should:

- Load course requirement from the student project `course` field.
- Verify the signed-in account is the student for this project.
- Resolve current membership using `resolveMembershipForAccount`.
- Compare tier priority of effective membership against the required tier.
- Include active grants naturally via membership resolution.
- Return enough display metadata for frontend banners.

This should also be exposed through Conat hub API so frontend does not reimplement priority logic.

### Student Direct Purchase

Replace the old `studentPay(project_id)` implementation with membership grant creation.

New function shape:

```ts
purchaseStudentCourseMembership({
  account_id,
  project_id,
  required_membership_class,
  amount?,
  credit_id?,
})
```

Behavior:

- Verify project is a course student project for `account_id` or verified email.
- Verify course requires `required_membership_class`.
- If account already has equal/higher active membership, return no-op success.
- Compute price from `membership_tiers.course_price`.
- Compute grant period from now to now + `course_duration_days`.
- Create a purchase with service probably still `student-pay` or a clearer new service like `student-course-membership`.
- Create `membership_grants`:
  - `membership_class = required_membership_class`
  - `source = "student-course-purchase"`
  - `purchase_id = purchase_id`
  - `starts_at = now`
  - `expires_at = now + duration`
  - metadata includes `project_id`, `course_project_id`, `course_path`, and `required_membership_class`
- Set project `usage_account_id = account_id`.
- Do not write `course.paid`; the grant and access resolver are the source of truth.

Stripe metadata should move from `{ project_id }` only to:

```json
{
  "project_id": "...",
  "required_membership_class": "...",
  "product": "student-course-membership"
}
```

### Third-Party Payer Links

The current code does not appear to implement a true third-party payer link. It only supports the signed-in student paying their own project and old transfer between projects.

Add a payment-request table or signed token model.

Recommended table:

```ts
student_course_payment_requests
  id uuid primary key
  student_account_id uuid not null
  project_id uuid not null
  course_project_id uuid not null
  required_membership_class text not null
  created_by_account_id uuid not null
  created_at timestamp not null
  expires_at timestamp not null
  paid_by_account_id uuid
  purchase_id integer
  completed_at timestamp
  canceled_at timestamp
```

Flow:

- Student clicks "Ask someone else to pay".
- Backend creates a payment request and returns a public URL.
- Parent/instructor opens URL, sees student/course/tier/price/duration.
- Payer completes Stripe checkout or uses account credit if signed in.
- Backend creates the membership grant for the student account, not the payer.
- Purchase records should clearly distinguish payer account from beneficiary account in description metadata.

Do not require the third-party payer to become a project collaborator.

### Instructor-Paid Seats

Reuse `membership_packages(kind="course")`.

Change quote/purchase behavior:

- For new course packages, `membership_class` must be supplied and must be course-store-visible.
- Seat price comes from `membership_tiers.course_price`.
- Package `starts_at = now`.
- Package `expires_at = now + course_duration_days`.
- Metadata keeps `course_project_id`, `course_path`, `course_title`, `seat_price`, `course_duration_days`.
- Remove dependency on `CourseInfo.payInfo`.

Assignment behavior can mostly stay:

- Assigning a seat creates a grant with source `course-seat`.
- Grant class is package membership class.
- Grant dates are package dates.
- Project usage attribution updates to the student account when `metadata.project_id` is provided.

Seat consumption should be explicit when a student is already covered:

- If the existing qualifying membership renews, show "covered by existing renewing membership" and do not consume a seat by default.
- If the existing qualifying membership expires, show "covered until DATE by existing membership".
- If `course_ends_at` is configured and the existing membership expires before that date, the instructor UI should treat the student as only temporarily covered and offer an explicit "assign seat anyway" action.
- If `course_ends_at` is not configured, do not confidently imply full-course coverage for expiring memberships; show the expiration date.

### Course Transfer

Delete the old transfer logic.

Reason: the membership priority rule makes it unnecessary. A student changing sections simply has the same active membership, so no course-specific license needs to move.

## Frontend Design

### Instructor Course Configuration

Replace "Start and end dates and upgrades..." with a simpler section:

- "Course payment"
- Choose one required student course membership tier.
- Show:
  - tier name,
  - price,
  - duration,
  - key resources/limits summary,
  - note that any equal-or-higher membership also satisfies the requirement.
- Choose payment mode:
  - Use matching site license, shown as the default if the instructor's verified email domain matches an active site license.
  - Students pay directly.
  - Instructor/institution buys seats.
  - No course payment requirement.

For site-license coverage:

- Check active site licenses whose allowed email domains match the instructor's verified email domain.
- If one or more matches, default the course payment mode to "Use site license".
- Show the site license tier, expiration, allowed domains, used seats, and seat cap.
- Still allow the instructor to choose student-pay or instructor-pay instead, since the site license may be too minimal for a course that needs more resources, AI, GPU-related limits, or higher project quotas.
- Student UI should prompt students to verify their email and claim the site license if their account is not already covered.

For instructor-pay:

- Keep existing seat purchase modal.
- Change copy from "course fee and upgrades" to "course access seats".
- Quote from selected tier, not old quota/date config.

For student-pay:

- Show a preview of the student banner and deadline policy.
- No quota editor.
- An optional course end date is allowed for coverage messaging and instructor seat decisions, but not for pricing.

### Student Project UI

Replace the old forced modal with a persistent banner/state machine:

- Covered:
  - "Your course access is active through ..."
- Grace:
  - "You have full access until DATE. Buy the COURSE PASS for $25 / 4 months."
  - Buttons: "Buy now", "Ask someone else to pay".
- Blocked:
  - "Course access payment is required to continue using this project."
  - Buttons: "Buy now", "Ask someone else to pay", "Close project".
- Existing higher membership:
  - renewing: "Your current renewing membership covers this course."
  - expiring: "Your current membership covers this course until DATE."
- Site license:
  - covered: "Your institution's site license covers this course."
  - not claimed: "Verify your email and claim your institution's site license to use this course."

The banner should mention exactly what membership/tier is required.

### Account Membership UI

When a student-course purchase exists, membership details should show it as a grant source:

- "Student course membership"
- purchased/covered by course
- expiration date

This should already mostly work if the grant is created normally, but the labels for `grant_source` should include `student-course-purchase` and `course-seat`.

### Store / Public Pricing

Update deferred language:

- Student memberships are not in normal store.
- Course access passes are bought from the course context.
- Public pricing can mention "Student course memberships may be offered through a course."

## Migration Strategy

### Phase 1: Add Course Tier Fields

- Add tier fields and admin UI.
- Update student template to `$25 / 122 days`.
- Add shared utility to list active course-eligible tiers.
- Tests for template fallback and admin tier round-trip.

### Phase 2: Remove Old Quota Student Pay

- Delete:
  - `src/packages/util/purchases/quota/student-pay.ts`
  - old `LicenseEditor` course payment UI
  - old course-fee transfer UI and endpoint
  - active reads/writes of course `payInfo`, `paid`, and `purchase_id`
- Tests should fail if new course payment UI writes quota-derived `payInfo`.

### Phase 3: Course Config Writes New Model

- Add course settings fields for required membership class, grace, optional course end date, and funding mode.
- Replace student-pay quota editor with tier selection.
- Add site-license defaulting when the instructor's verified email domain matches an active site license.
- Tests for course settings serialization, UI rendering, and site-license default selection.

### Phase 4: Access Resolver

- Implement backend resolver and Conat API.
- Update project banner/page to use resolver result.
- Stop using `ProjectsStore.date_when_course_payment_required` for new flows.
- Tests for no requirement, grace, active renewing membership, active expiring membership, higher priority, site-license claimable/claimed, expired, blocked.

### Phase 5: Student Direct Purchase

- Implement student-course purchase quote and purchase path.
- Update Stripe payment intent metadata and processing.
- Create grant source `student-course-purchase`.
- Record purchases with clear beneficiary metadata.
- Tests for direct purchase, idempotency, existing higher membership no-op, multi-bay account/project routing.

### Phase 6: Third-Party Payer Link

- Add payment request table/API.
- Add student UI to create/copy link.
- Add public/signed payment page.
- Create grant for student after payer completes payment.
- Tests for request creation, expiration, one-time completion, payer/beneficiary metadata, non-collaborator payer.

### Phase 7: Instructor-Paid Seats On New Model

- Change `getCourseSeatQuote` to use selected course membership tier.
- Require `membership_class` for course package creation.
- Remove `payInfo` dependency from instructor-pay UI and backend quotes.
- Keep current assignment/revoke mechanics.
- Tests for package quote, purchase, assignment, no-seat-available, existing renewing membership UI, and existing expiring membership UI.

## Smoke Test Plan

Use lite4b with Stripe test keys.

### Admin Setup

1. Confirm `student` tier has:
   - `course_store_visible = true`
   - `course_price = 25`
   - `course_duration_days = 122`
   - `store_visible = false`
2. Confirm normal store does not show the student tier.
3. Confirm an active site license with the instructor's verified email domain appears as the default course funding option.

### Student Pay

1. Instructor creates course.
2. Instructor selects `student` course membership and "students pay directly".
3. Student project is created.
4. Student sees full access and a 14-day deadline banner.
5. Student buys with Stripe test card.
6. Purchase creates `membership_grants.source = student-course-purchase`.
7. Banner changes to covered.
8. Student opens a second course requiring `student`; it is covered without a second purchase.
9. Student opens a course requiring a higher tier; it is not covered.
10. Student with an expiring qualifying membership sees "covered until DATE" instead of a vague covered state.

### Third-Party Payer

1. Student creates payer link.
2. Open link in another browser/account.
3. Payer pays with Stripe test card.
4. Student receives grant; payer does not.
5. Purchase metadata records both payer and student.

### Instructor Pay

1. Instructor selects same `student` tier and "instructor/institution buys seats".
2. Instructor buys N seats.
3. Instructor assigns a seat to a student.
4. Student receives `course-seat` grant.
5. Student project usage attribution changes to student account.
6. Revoking seat revokes grant and restores project usage attribution as designed.

### Site License

1. Create a site license for the instructor's verified email domain.
2. Instructor creates course.
3. Course payment defaults to "Use site license".
4. Student with a matching verified email can claim coverage.
5. Student without verified matching email sees a verify-email/claim-site-license prompt, not a payment prompt.

## Risks And Guardrails

- Do not consume instructor-paid seats for students already covered by a higher membership unless the instructor explicitly chooses to do so.
- Do not hide expiration: expiring memberships must say "covered until DATE"; only renewing memberships should be described as generally covered.
- Do not derive course price from project resources.
- Do not derive course price from course start/end dates.
- Do not make course access depend on one specific project once a student has a qualifying membership.
- Do not expose student tiers in the normal store unless explicitly marked for normal store visibility.
- Do not retain `payInfo` compatibility code in this greenfield implementation.
- Keep all writes bay-aware:
  - student membership grants belong on the student account home bay,
  - course packages belong on the owner account home bay,
  - project usage attribution writes route to the project-owning bay.
- Make purchase idempotency explicit:
  - direct purchase should not double-charge if an equivalent grant already exists,
  - third-party payment request should complete once.

## Settled Decisions From Review

1. Anchor grace per student from the later of student project creation and course requirement enable time.
2. Direct student purchase creates a direct membership grant, not a package plus assignment.
3. Normal `member`, `pro`, or other memberships satisfy a course requirement iff their priority is high enough.
4. Admins can mark more than one tier as course-visible.
5. Course seats can be assigned by verified email before a student account exists.
