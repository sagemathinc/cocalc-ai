import { lazy, Suspense, useState } from "react";
import { Button, Dropdown, Tag } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import type { IconName } from "@cocalc/frontend/components/icon";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import type {
  ArtifactPublication,
  ArtifactRecord,
  EntityTheme,
} from "@cocalc/chat";
const Appearance = lazy(() => import("./artifact-appearance-editor"));
const Thumbnail = lazy(() => import("./artifact-thumbnail"));

export function ArtifactIdentity({
  title,
  theme,
  icon = "file",
}: {
  title: string;
  theme?: EntityTheme;
  icon?: IconName;
}) {
  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          flex: "0 0 40px",
          height: 40,
          borderRadius: 10,
          background: UI_COLORS.surface,
          border: `1px solid ${theme?.color ?? UI_COLORS.border}`,
          fontSize: 22,
        }}
      >
        {theme?.image_blob ? (
          <img
            src={`${appBasePath}/blobs/theme-image.png?uuid=${encodeURIComponent(theme.image_blob)}`}
            alt=""
            style={{
              width: 38,
              height: 38,
              objectFit: "cover",
              borderRadius: 9,
            }}
          />
        ) : (
          <Icon name={(theme?.icon || icon) as IconName} />
        )}
      </span>
      <strong
        style={{
          fontSize: 16,
          lineHeight: 1.35,
          overflowWrap: "anywhere",
          minWidth: 0,
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          overflow: "hidden",
        }}
      >
        {theme?.title || title}
      </strong>
    </span>
  );
}

export function ArtifactCard({
  publication,
  current,
  open,
  syncdb,
  projectId,
}: {
  publication: ArtifactPublication;
  current?: ArtifactRecord;
  open?: (version?: string) => void;
  syncdb?: any;
  projectId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const published = publication.snapshot;
  const s = current
    ? {
        title: current.title,
        markdown: current.input,
        file: current.file,
        github_pr: current.github_pr,
        actions: current.actions,
        commit: current.commit,
        theme: current.theme,
      }
    : published;
  const updated =
    !!current &&
    (current.title !== published.title ||
      current.input !== published.markdown ||
      JSON.stringify(current.file) !== JSON.stringify(published.file) ||
      JSON.stringify(current.actions) !== JSON.stringify(published.actions) ||
      JSON.stringify(current.github_pr) !==
        JSON.stringify(published.github_pr) ||
      JSON.stringify(current.commit) !== JSON.stringify(published.commit));
  const theme = current?.theme ?? s.theme;
  const title = theme?.title || s.title;
  const kind = s.commit
    ? "Git commit"
    : s.github_pr
      ? "GitHub pull request"
      : s.actions
        ? "Proposed actions"
        : s.file
          ? "File reference"
          : "Collaborative document";
  const icon: IconName =
    s.commit || s.github_pr ? "git" : s.actions ? "tasks" : "file";
  const excerpt =
    theme?.description ||
    (s.actions
      ? s.actions
          .slice(0, 3)
          .map((a) => a.title)
          .join(" · ")
      : s.markdown.replace(/[#*`>]/g, "").trim());
  return (
    <article
      aria-label={`${kind}: ${title}`}
      style={{
        marginTop: 12,
        border: `1px solid ${UI_COLORS.border}`,
        borderInlineStart: `3px solid ${theme?.color ?? UI_COLORS.border}`,
        borderRadius: 12,
        background: theme?.accent_color
          ? `linear-gradient(120deg, color-mix(in srgb, ${theme.accent_color} 10%, ${UI_COLORS.surface}), ${UI_COLORS.surface})`
          : `linear-gradient(120deg, ${UI_COLORS.surface}, ${UI_COLORS.inset})`,
        color: UI_COLORS.text,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "start",
          padding: "14px 14px 8px",
          gap: 8,
        }}
      >
        {open ? (
          <Button
            type="text"
            aria-label={`Open artifact: ${title}`}
            disabled={!open}
            onClick={(e) => {
              e.stopPropagation();
              open?.();
            }}
            style={{
              padding: 0,
              height: "auto",
              whiteSpace: "normal",
              textAlign: "start",
              flex: 1,
              minWidth: 0,
              justifyContent: "start",
              color: "inherit",
            }}
          >
            <ArtifactIdentity title={s.title} theme={theme} icon={icon} />
          </Button>
        ) : (
          <ArtifactIdentity title={s.title} theme={theme} icon={icon} />
        )}
        {open && (
          <Dropdown
            autoFocus
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "published",
                  label: published.file
                    ? "Published reference"
                    : "Published version",
                },
                ...(current && syncdb
                  ? [{ key: "appearance", label: "Edit appearance" }]
                  : []),
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === "appearance") setEditing(true);
                else open(publication.operation_id);
              },
            }}
          >
            <Button
              type="text"
              aria-label={`More options for ${title}`}
              onClick={(e) => e.stopPropagation()}
              icon={<Icon name="ellipsis" />}
            />
          </Dropdown>
        )}
      </div>
      <div style={{ padding: "0 16px 14px", overflowWrap: "anywhere" }}>
        <div
          style={{ fontSize: 12, color: UI_COLORS.secondary, marginBottom: 8 }}
        >
          {kind}
          {s.github_pr
            ? ` · ${s.github_pr.repository} #${s.github_pr.number}`
            : ""}
        </div>
        {updated && (
          <div
            style={{
              fontSize: 11,
              color: UI_COLORS.secondary,
              marginBottom: 6,
            }}
          >
            Updated since this message
          </div>
        )}
        {excerpt && (
          <div
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              lineHeight: 1.5,
              marginBottom: 8,
            }}
          >
            {excerpt.slice(0, 280)}
          </div>
        )}
        {s.file && (
          <div>
            <code>{s.file.path}</code>
            <div style={{ fontSize: 12, color: UI_COLORS.secondary }}>
              Current saved file, not historical contents
            </div>
          </div>
        )}
        {(theme?.image_blob ||
          (projectId &&
            s.file &&
            /\.(png|jpe?g|gif|webp)$/i.test(s.file.path))) && (
          <Suspense fallback={<div style={{ height: 180 }} />}>
            <Thumbnail
              imageBlob={theme?.image_blob}
              path={s.file?.path}
              projectId={projectId}
              title={title}
            />
          </Suspense>
        )}
        {s.actions && (
          <Tag>{s.actions.length} proposed actions · Review drafts</Tag>
        )}
        {s.github_pr && (
          <>
            <Tag>{s.github_pr.draft ? "Draft" : s.github_pr.state}</Tag>
            <Tag>Checks: {s.github_pr.checks}</Tag>
            <div style={{ fontSize: 11, color: UI_COLORS.secondary }}>
              Status retrieved {s.github_pr.fetched_at}
            </div>
          </>
        )}
        {s.commit && (
          <>
            <code>{s.commit.sha.slice(0, 12)}</code>
            {s.commit.branch && ` · ${s.commit.branch}`}
            <div style={{ fontSize: 12 }}>{s.commit.path}</div>
          </>
        )}
      </div>
      {editing && current && (
        <Suspense
          fallback={<div role="status">Loading appearance editor...</div>}
        >
          <Appearance
            artifact={current}
            syncdb={syncdb}
            projectId={projectId}
            onClose={() => setEditing(false)}
          />
        </Suspense>
      )}
    </article>
  );
}
