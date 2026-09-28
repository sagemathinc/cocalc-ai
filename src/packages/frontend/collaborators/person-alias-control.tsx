import { useEffect, useId, useRef, useState } from "react";
import { Button, Input } from "antd";
import type { InputRef } from "antd";
import {
  normalizePrivateAlias,
  privateAliasPath,
} from "@cocalc/util/private-alias";
import { boundCollaboratorsApi } from "./workspace-api";
import type { DirectoryApi } from "./workspace-api";
import { CollaboratorsModal } from "./modal";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export interface PersonAliasControlProps {
  accountId: string;
  personId: string;
  /** Optional injection for tests; production uses an account/session-bound API. */
  api?: Pick<DirectoryApi, "getPersonAlias" | "setPersonAlias">;
  onChange?: (alias: string | null) => void;
  /** Initial successful lookup, including an absent alias. */
  onResolve?: (alias: string | null) => void;
  compact?: boolean;
}

export function PersonAliasControl(props: PersonAliasControlProps) {
  // Remount on identity changes: drafts/errors never cross account/person boundaries.
  return (
    <PersonAliasForm key={`${props.accountId}:${props.personId}`} {...props} />
  );
}

function PersonAliasForm({
  accountId,
  personId,
  api: providedApi,
  onChange,
  onResolve,
  compact = false,
}: PersonAliasControlProps) {
  const [api] = useState(() => providedApi ?? boundCollaboratorsApi(accountId));
  const id = useId();
  const mounted = useRef(false);
  const onResolveRef = useRef(onResolve);
  onResolveRef.current = onResolve;
  const [alias, setAlias] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState(false);
  const input = useRef<InputRef>(null);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    void api
      .getPersonAlias({ person_id: personId })
      .then((value) => {
        if (disposed) return;
        setSaved(value.alias);
        setAlias(value.alias ?? "");
        setLoading(false);
        onResolveRef.current?.(value.alias);
      })
      .catch((err) => {
        if (!disposed) {
          setError(`${err}`);
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
      mounted.current = false;
    };
  }, [api, personId]);

  async function save() {
    if (loading || busy) return;
    setError(undefined);
    setStatus("");
    setBusy(true);
    try {
      const value = alias.trim() ? normalizePrivateAlias(alias) : "";
      const result = await api.setPersonAlias({
        person_id: personId,
        alias: value,
      });
      if (!mounted.current) return;
      setSaved(result.alias);
      setAlias(result.alias ?? "");
      setStatus("Private alias saved.");
      onChange?.(result.alias);
    } catch (err) {
      if (mounted.current) setError(`${err}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id}>Private person alias</label>
      <Input
        ref={input}
        autoFocus={compact}
        id={id}
        value={alias}
        disabled={loading || busy}
        maxLength={32}
        aria-describedby={`${id}-help`}
        aria-invalid={!!error}
        onChange={(event) => setAlias(event.target.value)}
      />
      <p id={`${id}-help`}>
        Only you use this alias. It does not change this person's name or
        access. Leave blank to remove it.
      </p>
      <Button
        htmlType="submit"
        loading={busy}
        disabled={loading || busy || alias === (saved ?? "")}
      >
        Save alias
      </Button>
      {saved && (
        <p>
          Private address: <code>{privateAliasPath("people", saved)}</code>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <p role="status">{loading ? "Loading private alias..." : status}</p>
    </form>
  );
  if (!compact) return form;
  return (
    <>
      <Button
        type="text"
        size="small"
        aria-haspopup="dialog"
        aria-label={
          saved ? `Edit private alias @${saved}` : "Add private alias"
        }
        onClick={() => {
          setAlias(saved ?? "");
          setStatus("");
          setEditing(true);
        }}
      >
        {saved ? `@${saved}` : "Add private alias"}
      </Button>
      {error && !editing && (
        <span role="alert">
          Private alias needs attention. Open it for details.
        </span>
      )}
      <CollaboratorsModal
        open={editing}
        title="Private alias"
        footer={null}
        onCancel={() => setEditing(false)}
        afterOpenChange={(open) => {
          if (open) input.current?.focus();
        }}
        destroyOnHidden
      >
        <KeyboardBoundary boundary="person-alias">{form}</KeyboardBoundary>
      </CollaboratorsModal>
    </>
  );
}
