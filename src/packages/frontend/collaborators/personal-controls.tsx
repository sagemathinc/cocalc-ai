/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Dropdown, Input } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { CollaboratorsModal } from "./modal";
import type { DirectoryApi } from "./workspace-api";
import type {
  CollaborationPersonalState,
  CollaborationResource,
} from "@cocalc/util/collaborators";
import { emptyCollaborationPersonalState } from "@cocalc/util/collaborators";

export function PersonalControls({
  api,
  resource,
  onChange,
  compact = false,
  onShare,
}: {
  api: DirectoryApi;
  resource: CollaborationResource;
  onChange: () => void;
  compact?: boolean;
  onShare?: () => void;
}) {
  const id = useId();
  const [personal, setPersonal] = useState(
    resource.personal ?? emptyCollaborationPersonalState(),
  );
  const [alias, setAlias] = useState(personal.alias ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [aliasOpen, setAliasOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const aliasUnavailable = resource.kind === "artifact" && !resource.entry_id;
  const collectionUnavailable =
    resource.kind === "artifact" && !resource.artifact_id;
  const priorPersonal = useRef(resource.personal);
  useEffect(() => {
    if (pending.current) return;
    const previous = priorPersonal.current;
    priorPersonal.current = resource.personal;
    const next = resource.personal ?? emptyCollaborationPersonalState();
    setPersonal(next);
    setAlias((input) =>
      input === (previous?.alias ?? "") ? (next.alias ?? "") : input,
    );
  }, [resource.personal]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function update(patch: Partial<CollaborationPersonalState>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const value = await api.setPersonalState({
        project_id: resource.project_id,
        kind: resource.kind,
        resource_id: resource.resource_id,
        patch,
      });
      if (!mounted.current) return;
      setPersonal(value);
      setSaved("Personal preferences saved.");
      if (patch.alias !== undefined) setAliasOpen(false);
      onChange();
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const aliasForm = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void update({ alias: alias.trim() });
      }}
    >
      <label htmlFor={id}>Private alias</label>
      <div className="collaborators-actions">
        <Input
          id={id}
          value={alias}
          maxLength={80}
          onChange={(event) => setAlias(event.target.value)}
          style={{ width: 200, maxWidth: "100%" }}
        />
        <Button
          htmlType="submit"
          disabled={
            busy || aliasUnavailable || alias === (personal.alias ?? "")
          }
        >
          Save alias
        </Button>
      </div>
    </form>
  );
  if (compact)
    return (
      <div className="collaborators-conversation-actions">
        <Button
          type="text"
          aria-label={
            personal.collected ? "Unpin conversation" : "Pin conversation"
          }
          aria-pressed={personal.collected}
          disabled={busy || collectionUnavailable}
          icon={
            <Icon name={personal.collected ? "pushpin-filled" : "pushpin"} />
          }
          onClick={() => void update({ collected: !personal.collected })}
        />
        <Dropdown
          trigger={["click"]}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          autoFocus
          menu={{
            items: [
              {
                key: "alias",
                label: "Private alias...",
                disabled: busy || aliasUnavailable,
              },
              {
                key: "follow",
                label: personal.following ? "Unfollow" : "Follow",
                disabled: busy,
              },
              {
                key: "mute",
                label: personal.muted ? "Unmute" : "Mute",
                disabled: busy,
              },
              {
                key: "read",
                label: "Mark read",
                disabled: busy || personal.read_through >= resource.activity,
              },
              ...(onShare
                ? [
                    { type: "divider" as const },
                    { key: "share", label: "Share conversation..." },
                  ]
                : []),
            ],
            onClick: ({ key }) => {
              setMenuOpen(false);
              menuButton.current?.focus();
              if (key === "alias") setAliasOpen(true);
              if (key === "follow")
                void update({ following: !personal.following });
              if (key === "mute") void update({ muted: !personal.muted });
              if (key === "read")
                void update({ read_through: resource.activity });
              if (key === "share") onShare?.();
            },
          }}
          popupRender={(menu) => (
            <KeyboardBoundary
              boundary="conversation-options"
              onKeyDown={(event) => {
                // Menu activation must not reach the embedded chat's shortcuts
                // after an action restores focus to the header.
                event.stopPropagation();
                // Opening a modal moves focus to its Close button before the
                // browser performs Enter's default click.
                if (event.key === "Enter") event.preventDefault();
                if (event.key === "Escape") {
                  setMenuOpen(false);
                  menuButton.current?.focus();
                }
              }}
            >
              {menu}
            </KeyboardBoundary>
          )}
        >
          <Button
            ref={menuButton}
            type="text"
            aria-label="Conversation options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            icon={<Icon name="ellipsis" />}
          />
        </Dropdown>
        <CollaboratorsModal
          title="Private alias"
          open={aliasOpen}
          footer={null}
          onCancel={() => setAliasOpen(false)}
          afterClose={() => menuButton.current?.focus()}
        >
          <KeyboardBoundary boundary="conversation-alias">
            {aliasForm}
            <p>
              Only you see this alias. It does not change who can access the
              conversation.
            </p>
            {error && (
              <Alert
                role="alert"
                type="error"
                title="Preferences not saved"
                description={error}
              />
            )}
          </KeyboardBoundary>
        </CollaboratorsModal>
        {error && !aliasOpen && (
          <Alert
            role="alert"
            type="error"
            title="Preferences not saved"
            description={error}
          />
        )}
        <span className="collaborators-sr-only" role="status">
          {busy ? "Saving preferences..." : saved}
        </span>
      </div>
    );
  return (
    <section
      aria-label="Your preferences"
      className="collaborators-preferences"
    >
      {aliasForm}
      <div className="collaborators-actions">
        <Button
          disabled={busy || collectionUnavailable}
          aria-pressed={personal.collected}
          onClick={() => void update({ collected: !personal.collected })}
        >
          {personal.collected ? "Remove shortcut" : "Add to my collection"}
        </Button>
        {resource.kind === "conversation" && (
          <>
            <Button
              disabled={busy}
              aria-pressed={personal.following}
              onClick={() => void update({ following: !personal.following })}
            >
              {personal.following ? "Unfollow" : "Follow"}
            </Button>
            <Button
              disabled={busy}
              aria-pressed={personal.muted}
              onClick={() => void update({ muted: !personal.muted })}
            >
              {personal.muted ? "Unmute" : "Mute"}
            </Button>
            <Button
              disabled={busy || personal.read_through >= resource.activity}
              onClick={() => void update({ read_through: resource.activity })}
            >
              Mark read
            </Button>
          </>
        )}
      </div>
      <small>
        Only your preferences change. Shortcuts and aliases do not grant access,
        start agents, or change following.
      </small>
      {error && (
        <Alert
          role="alert"
          type="error"
          title="Preferences not saved"
          description={error}
        />
      )}
      <span role="status">{busy ? "Saving preferences..." : saved}</span>
    </section>
  );
}
