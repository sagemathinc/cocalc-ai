/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A minimal "New project": a name and the defaults on one line, with
// "More options" for the full creator. Uses the same draft (defaults, image,
// host, region) and create path as the full creator.

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Typography, type InputRef } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { useProjectRuntimeCapabilities } from "@cocalc/frontend/project/runtime-capabilities";
import { R2_REGION_LABELS } from "@cocalc/util/consts";
import { projectDraftToCreateOptions } from "./create/project-create-draft";
import { useProjectCreateDraft } from "./create/use-project-create-draft";

export function QuickProjectCreator({
  open,
  defaultTitle = "",
  onClose,
  onMoreOptions,
}: {
  open: boolean;
  defaultTitle?: string;
  onClose: () => void;
  onMoreOptions: (title: string) => void;
}) {
  const runtime = useProjectRuntimeCapabilities();
  const { draft, summary, rootfsLoading } = useProjectCreateDraft({
    defaultValue: defaultTitle,
  });
  const [title, setTitle] = useState(defaultTitle);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const inputRef = useRef<InputRef>(null);
  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle);
    setError("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, defaultTitle]);

  const needsImage = runtime.rootfs && !summary.rootfs_image.trim();
  const defaults = [
    runtime.rootfs
      ? rootfsLoading && needsImage
        ? "Loading images..."
        : summary.rootfsLabel || summary.rootfs_image
      : undefined,
    runtime.host_placement
      ? summary.hostName
        ? `host ${summary.hostName}`
        : "automatic host"
      : undefined,
    `backups in ${R2_REGION_LABELS[summary.region] ?? summary.region}`,
  ].filter(Boolean);

  async function create() {
    if (creating.current) return;
    const name = title.trim();
    if (!name) {
      setError("Please name your project.");
      return;
    }
    if (needsImage) {
      setError("No image is available yet; try More options.");
      return;
    }
    creating.current = true;
    setBusy(true);
    setError("");
    try {
      const opts = projectDraftToCreateOptions({
        ...draft,
        title: name,
        start: true,
      });
      if (!runtime.rootfs) {
        delete opts.rootfs_image;
        delete opts.rootfs_image_id;
      }
      if (!runtime.host_placement) delete opts.host_id;
      const actions = redux.getActions("projects");
      const project_id = await actions.create_project(opts);
      actions.open_project({ project_id, target: "files/", switch_to: true });
      onClose();
    } catch (err) {
      setError(`${err}`.replace(/^Error: /, ""));
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="New project"
      onCancel={onClose}
      destroyOnHidden
      footer={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button
            type="link"
            style={{ paddingLeft: 0 }}
            onClick={() => onMoreOptions(title)}
          >
            More options…
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            loading={busy}
            disabled={busy || !title.trim()}
            icon={<Icon name="arrow-right" />}
            onClick={() => void create()}
          >
            Create and open
          </Button>
        </div>
      }
    >
      <Input
        ref={inputRef}
        size="large"
        aria-label="Project name"
        placeholder="Name your project"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onPressEnter={() => void create()}
      />
      <Typography.Paragraph
        type="secondary"
        style={{ marginTop: 10, marginBottom: 0, fontSize: 13 }}
      >
        {defaults.join(" · ")}
        {". "}
        Everything can be changed later.
      </Typography.Paragraph>
      {summary.warnings.length > 0 && (
        <Alert
          type="warning"
          style={{ marginTop: 10 }}
          title={summary.warnings.join(" ")}
        />
      )}
      {error && (
        <Alert
          role="alert"
          type="error"
          style={{ marginTop: 10 }}
          title={error}
        />
      )}
    </Modal>
  );
}
