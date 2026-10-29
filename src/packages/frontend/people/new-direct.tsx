/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Start a direct conversation: with collaborators directly, or with anyone
// by their exact username (they get a message request).
//
// Finding people uses the same search as adding collaborators to a project
// (names match your collaborators; an exact email address finds a
// collaborator by email), plus an exact @username for anyone else. Every
// result says who it is: avatar, collaborator or not, the projects you share,
// when they were last active and joined, and the email when it matched.

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popover,
  Space,
  Tag,
  Typography,
} from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { TimeAgo } from "@cocalc/frontend/components";
// The same editor as chat (rich text or Markdown, image paste).
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  MAX_DIRECT_MEMBERS,
  normalizeDirectUsername,
  type MemberDirectConversation,
} from "@cocalc/util/direct-conversations";
import { peopleApi } from "./api";
import { usePeople } from "./collaborators";
import { directChanged } from "./use-direct";

// Someone you can add: a collaborator (sent by account id) or someone found
// by exact username (sent as the username; they get a request).
export interface Recipient {
  account_id: string;
  name: string;
  collaborator: boolean;
  username?: string;
  email_address?: string;
  last_active?: number;
  created?: number;
}

// Titles of the projects you share with someone, from your project list.
function useSharedProjects(): (account_id: string) => string[] {
  const project_map = useTypedRedux("projects", "project_map");
  const me = useTypedRedux("account", "account_id");
  return useMemo(() => {
    const shared = new Map<string, string[]>();
    project_map?.forEach((project, project_id) => {
      if (project.get("deleted")) return;
      const users = project.get("users");
      if (!users?.has(me)) return;
      const title = `${project.get("title") ?? project_id}`;
      users.forEach((_, id) => {
        if (id === me) return;
        shared.set(id, [...(shared.get(id) ?? []), title]);
      });
    });
    return (account_id: string) => shared.get(account_id) ?? [];
  }, [project_map, me]);
}

function SharedProjects({ titles }: { titles: string[] }) {
  if (titles.length === 0) {
    return <span>No shared projects</span>;
  }
  const label = `${titles.length} shared project${titles.length === 1 ? "" : "s"}`;
  return (
    <Popover
      title="Projects you share"
      content={
        <ul
          aria-label="Shared projects"
          style={{
            margin: 0,
            paddingLeft: 18,
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {titles.map((title, i) => (
            <li key={`${title}-${i}`}>{title}</li>
          ))}
        </ul>
      }
    >
      <Button type="link" size="small" style={{ padding: 0, height: "auto" }}>
        {label}
      </Button>
    </Popover>
  );
}

// One person, with everything that tells them apart from others of the same
// name.
export function RecipientCard({
  recipient,
  sharedProjects,
  action,
}: {
  recipient: Recipient;
  sharedProjects: string[];
  action?: React.ReactNode;
}) {
  const details: React.ReactNode[] = [
    recipient.collaborator ? (
      <Tag key="kind" color="green" style={{ marginInlineEnd: 0 }}>
        Collaborator
      </Tag>
    ) : (
      <Tag key="kind" color="blue" style={{ marginInlineEnd: 0 }}>
        Message request
      </Tag>
    ),
    <SharedProjects key="shared" titles={sharedProjects} />,
  ];
  if (recipient.username)
    details.push(<span key="u">@{recipient.username}</span>);
  if (recipient.email_address) {
    details.push(<span key="e">{recipient.email_address}</span>);
  }
  if (recipient.last_active) {
    details.push(
      <span key="a">
        Active <TimeAgo date={recipient.last_active} />
      </span>,
    );
  }
  if (recipient.created) {
    details.push(
      <span key="c">
        Joined {new Date(recipient.created).toLocaleDateString()}
      </span>,
    );
  }
  return (
    <div
      aria-label={recipient.name}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        padding: "8px 10px",
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 8,
        marginTop: 6,
      }}
    >
      <Avatar account_id={recipient.account_id} size={32} no_tooltip />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{recipient.name}</div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "2px 12px",
            alignItems: "center",
            fontSize: 12,
            color: UI_COLORS.secondary,
          }}
        >
          {details}
        </div>
      </div>
      {action}
    </div>
  );
}

function nameOf(user: {
  display_name?: string;
  first_name?: string;
  last_name?: string;
}): string {
  return (
    user.display_name?.trim() ||
    `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() ||
    "Unknown"
  );
}

export function NewDirectModal({
  open,
  personId,
  onClose,
  onStarted,
}: {
  open: boolean;
  personId?: string;
  onClose: () => void;
  onStarted: (conversation: MemberDirectConversation) => void;
}) {
  const people = usePeople();
  const me = useTypedRedux("account", "account_id");
  const sharedProjects = useSharedProjects();
  const [to, setTo] = useState<Recipient[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Recipient[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState(0);

  const collaborators = useMemo(
    () => new Set(people.map((p) => p.account_id)),
    [people],
  );

  useEffect(() => {
    if (!open) return;
    const person = people.find((p) => p.account_id === personId);
    setTo(
      person
        ? [
            {
              account_id: person.account_id,
              name: person.name,
              collaborator: true,
            },
          ]
        : [],
    );
    setQuery("");
    setResults(null);
    setTitle("");
    setBody("");
    setError("");
    // Only when the dialog opens (people may update meanwhile).
  }, [open, personId]);

  const full = to.length >= MAX_DIRECT_MEMBERS - 1;

  async function search() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError("");
    try {
      const found = new Map<string, Recipient>();
      // Collaborators by name or exact email: the same search as adding
      // collaborators to a project.
      if (!q.startsWith("@")) {
        const users = await webapp_client.users_client.user_search({
          query: q,
          limit: 30,
        });
        for (const user of users) {
          if (user.account_id === me) continue;
          found.set(user.account_id, {
            account_id: user.account_id,
            name: nameOf(user),
            collaborator: collaborators.has(user.account_id),
            email_address: user.email_address,
            last_active: user.last_active,
            created: user.created,
          });
        }
      }
      // Anyone, by exact username (they get a message request).
      const username = normalizeDirectUsername(q);
      if (username != null) {
        const user = await peopleApi().findDirectRecipient({ username });
        if (user != null && user.account_id !== me) {
          const known = found.get(user.account_id);
          found.set(user.account_id, {
            ...known,
            account_id: user.account_id,
            name: known?.name ?? user.name,
            collaborator: collaborators.has(user.account_id),
            username: user.username,
          });
        }
      }
      setResults([...found.values()]);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSearching(false);
    }
  }

  function add(recipient: Recipient) {
    setTo((list) =>
      list.some((r) => r.account_id === recipient.account_id) ||
      list.length >= MAX_DIRECT_MEMBERS - 1
        ? list
        : [...list, recipient],
    );
  }

  function remove(account_id: string) {
    setTo((list) => list.filter((r) => r.account_id !== account_id));
  }

  async function start() {
    setBusy(true);
    setError("");
    try {
      const conversation = await peopleApi().startDirect({
        // Collaborators by id; anyone else only by username.
        member_ids: to.filter((r) => r.collaborator).map((r) => r.account_id),
        usernames: to
          .filter((r) => !r.collaborator && r.username)
          .map((r) => r.username!),
        title: to.length > 1 ? title : null,
        body,
      });
      directChanged();
      onStarted(conversation);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="New message"
      okText="Send"
      okButtonProps={{
        disabled: to.length === 0 || !body.trim() || uploads > 0,
      }}
      confirmLoading={busy}
      onOk={start}
      onCancel={onClose}
      destroyOnHidden
      width={640}
    >
      <Form layout="vertical">
        <Form.Item
          label="To"
          htmlFor="people-new-direct-search"
          extra={`Names and email addresses find your collaborators; @username finds anyone else, who gets a message request they can accept or decline. Up to ${MAX_DIRECT_MEMBERS - 1} people; no shared project needed.`}
        >
          <Space.Compact style={{ width: "100%" }}>
            <Input
              id="people-new-direct-search"
              placeholder="Name, email address, or @username"
              value={query}
              disabled={full}
              onChange={(e) => setQuery(e.target.value)}
              onPressEnter={() => void search()}
            />
            <Button
              type="primary"
              loading={searching}
              disabled={!query.trim() || full}
              onClick={() => void search()}
            >
              Search
            </Button>
          </Space.Compact>
          {results != null && (
            <section aria-label="Search results" style={{ marginTop: 4 }}>
              {results.length === 0 ? (
                <Typography.Text type="secondary">
                  No one found. Names and email addresses only find your
                  collaborators; for anyone else, use their exact @username.
                </Typography.Text>
              ) : (
                results.map((r) => {
                  const added = to.some((t) => t.account_id === r.account_id);
                  return (
                    <RecipientCard
                      key={r.account_id}
                      recipient={r}
                      sharedProjects={sharedProjects(r.account_id)}
                      action={
                        <Button
                          size="small"
                          aria-label={`Add ${r.name}`}
                          disabled={
                            added || full || (!r.collaborator && !r.username)
                          }
                          onClick={() => add(r)}
                        >
                          {added ? "Added" : "Add"}
                        </Button>
                      }
                    />
                  );
                })
              )}
            </section>
          )}
        </Form.Item>
        {to.length > 0 && (
          <section aria-label="Recipients" style={{ marginBottom: 16 }}>
            <Typography.Text strong>
              Sending to {to.length} {to.length === 1 ? "person" : "people"}
            </Typography.Text>
            {to.map((r) => (
              <RecipientCard
                key={r.account_id}
                recipient={r}
                sharedProjects={sharedProjects(r.account_id)}
                action={
                  <Button
                    size="small"
                    aria-label={`Remove ${r.name}`}
                    onClick={() => remove(r.account_id)}
                  >
                    Remove
                  </Button>
                }
              />
            ))}
          </section>
        )}
        {to.length > 1 && (
          <Form.Item label="Title (optional)" htmlFor="people-new-direct-title">
            <Input
              id="people-new-direct-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Form.Item>
        )}
        <Form.Item label="Message">
          <div aria-label="Message">
            <MarkdownInput
              value={body}
              onChange={setBody}
              enableUpload
              onUploadStart={() => setUploads((n) => n + 1)}
              onUploadEnd={() => setUploads((n) => Math.max(0, n - 1))}
              onShiftEnter={() => {
                if (to.length > 0 && body.trim()) void start();
              }}
              height="auto"
              autoGrowMaxHeight={240}
              compact
            />
          </div>
        </Form.Item>
        {error && <Alert type="error" role="alert" title={error} />}
      </Form>
    </Modal>
  );
}
