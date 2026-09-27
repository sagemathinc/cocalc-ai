/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
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
}: {
  api: DirectoryApi;
  resource: CollaborationResource;
  onChange: () => void;
}) {
  const id = useId();
  const [personal, setPersonal] = useState(
    resource.personal ?? emptyCollaborationPersonalState(),
  );
  const [alias, setAlias] = useState(personal.alias ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
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
      onChange();
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Your preferences"
      className="collaborators-preferences"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void update({ alias: alias.trim() });
        }}
      >
        <label htmlFor={id}>Personal alias</label>
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
