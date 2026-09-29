import { render, screen, within } from "@testing-library/react";
import type {
  PeopleInvitationOperation,
  PeopleInvitationReview,
} from "@cocalc/util/people-invitations";
import {
  InvitationReviewDetails,
  InvitationResults,
} from "./invitation-review";

const review: PeopleInvitationReview = {
  review_id: "review",
  expires_at: 1800000000000,
  draft: {
    draft_id: "draft",
    revision: 3,
    account_id: "sender",
    created_at: 1700000000000,
    expires_at: 1800000000000,
    payload: {
      recipient: { kind: "account", account_id: "recipient" },
      projects: [
        { project_id: "project", action: "offer_access", role: "collaborator" },
      ],
      message: "Please look at this notebook.",
      channels: { notification: true, email: true },
    },
    preflight: [
      {
        project_id: "project",
        action: "offer_access",
        recipient_access: "insufficient",
        warnings: [
          "compatible_pending_offer",
          "content_requires_collaborator",
          "Additional server warning",
        ],
      },
    ],
  },
};

it("explains known warnings without hiding unknown server warnings or changing the reviewed offer", () => {
  render(
    <InvitationReviewDetails
      review={review}
      recipientLabel="Bella"
      projects={{}}
    />,
  );
  const details = screen.getByRole("region", {
    name: "Exact reviewed invitation",
  });
  expect(details).toHaveTextContent(
    "A compatible invitation is already pending",
  );
  expect(details).toHaveTextContent("without changing its role or read policy");
  expect(details).toHaveTextContent("A viewer is not upgraded automatically");
  expect(details).toHaveTextContent(
    "the recipient must accept the reviewed collaborator offer",
  );
  expect(details).toHaveTextContent("Additional server warning");
  expect(details).not.toHaveTextContent("compatible_pending_offer");
  expect(details).not.toHaveTextContent("content_requires_collaborator");
  expect(details).toHaveTextContent(
    "Invite as collaborator (project read/write and runtimes)",
  );
  expect(within(details).queryByRole("button")).toBeNull();
});

it("does not report a queued email as sent or invite creation as delivery success", () => {
  const operation: PeopleInvitationOperation = {
    operation_id: "operation",
    account_id: "sender",
    draft_id: "draft",
    revision: 3,
    payload: review.draft.payload,
    status: "complete",
    created_at: 1700000000000,
    updated_at: 1700000000000,
    source_version: 1,
    outcomes: [
      {
        child_operation_id: "child",
        project_id: "project",
        action: "offer_access",
        status: "created",
        delivery: [
          { channel: "notification", status: "queued" },
          { channel: "email", status: "queued" },
        ],
      },
    ],
  };
  render(<InvitationResults operation={operation} projects={{}} />);
  const results = screen.getByRole("region", {
    name: "Durable invitation outcomes",
  });
  expect(results).toHaveTextContent("Invitation created");
  expect(results).toHaveTextContent("Notification queued");
  expect(results).toHaveTextContent("Email queued, not yet sent");
  expect(results).not.toHaveTextContent("Email sent");
  expect(results).not.toHaveTextContent("Notification sent");
});
