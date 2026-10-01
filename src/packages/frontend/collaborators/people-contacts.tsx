/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Tag } from "antd";
import type {
  PeopleContact,
  PeopleInvitationHistoryRow,
} from "@cocalc/util/people-invitation-history";
import type { PeopleHistoryApi } from "./people-history-api";
import { DirectoryResults } from "./directory-results";
import { useDirectory } from "./use-directory";
import { onCollabInvitesChanged } from "./invite-events";
import { InvitationHistory } from "./invitation-history";

export function PeopleContacts({
  api,
  active,
  search,
  onSelect,
}: {
  api: PeopleHistoryApi;
  active: boolean;
  search?: string;
  onSelect: (contact: PeopleContact) => void;
}) {
  const binding = useRef({ api, version: 0 });
  if (binding.current.api !== api)
    binding.current = { api, version: binding.current.version + 1 };
  const result = useDirectory<PeopleContact>(
    JSON.stringify(["invited-people", search, binding.current.version]),
    async (cursor) => {
      const page = await api.listPeopleContacts({
        cursor,
        limit: 25,
        without_shared_projects: true,
        search,
      });
      return {
        items: page.items,
        next: page.next_cursor,
        coverage: "complete" as const,
      };
    },
    active,
    true,
    (contact) => contact.person_id,
  );
  useEffect(() => onCollabInvitesChanged(() => result.refresh()), []);
  return (
    <DirectoryResults
      label="Invited people"
      heading={<h3>Invited people</h3>}
      result={result}
      empty="No additional invited people."
    >
      {(items) => (
        <div role="list" aria-label="Invited people">
          {items.map((contact) => (
            <div role="listitem" key={contact.person_id}>
              <Button type="text" onClick={() => onSelect(contact)}>
                {contact.display_label || contact.email || "Invited person"}
              </Button>
              <Tag>Invited</Tag>
            </div>
          ))}
        </div>
      )}
    </DirectoryResults>
  );
}

export function ContactOverview({
  api,
  contactId,
  onInvite,
  onOpen,
  projectTitle,
}: {
  api: PeopleHistoryApi;
  contactId: string;
  onInvite: (contact: PeopleContact) => void;
  onOpen?: (row: PeopleInvitationHistoryRow) => void;
  projectTitle?: (projectId: string) => string | undefined;
}) {
  const [contact, setContact] = useState<PeopleContact>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    setContact(undefined);
    setError(undefined);
    void api
      .getPeopleContact({ person_id: contactId })
      .then((value) => {
        if (!current) return;
        if (value) setContact(value);
        else setError("This contact is no longer available.");
      })
      .catch((err) => {
        if (current) setError(String(err));
      });
    return () => {
      current = false;
    };
  }, [api, contactId]);
  if (error)
    return (
      <Alert
        role="alert"
        type="error"
        title="Unable to load person"
        description={error}
      />
    );
  if (!contact) return <p role="status">Loading person...</p>;
  return (
    <>
      <h2>{contact.display_label || contact.email || "Invited person"}</h2>
      {contact.email && <p>{contact.email}</p>}
      {!contact.linked_account_id && (
        <p>
          This is your private email contact. An invitation acceptance alone
          does not verify their account identity.
        </p>
      )}
      <Button onClick={() => onInvite(contact)}>Invite to projects</Button>
      <InvitationHistory
        api={api}
        personId={contact.person_id}
        onOpen={onOpen}
        projectTitle={projectTitle}
      />
    </>
  );
}
