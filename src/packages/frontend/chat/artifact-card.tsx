import { lazy, Suspense, useState } from "react";
import { Button, Dropdown } from "antd";
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
  const hasThumbnail = !!(
    theme?.image_blob ||
    (projectId && s.file && /\.(png|jpe?g|gif|webp)$/i.test(s.file.path))
  );
  const metadata = s.commit
    ? `${s.commit.sha.slice(0, 12)}${s.commit.branch ? ` · ${s.commit.branch}` : ""}`
    : s.github_pr
      ? `${s.github_pr.repository} #${s.github_pr.number} · ${s.github_pr.draft ? "Draft" : s.github_pr.state} · Checks: ${s.github_pr.checks}`
      : s.actions
        ? `${s.actions.length} proposed actions · Review drafts`
        : s.file
          ? s.file.path
          : excerpt;
  const details = [
    kind,
    metadata,
    excerpt,
    s.file ? "Current saved file, not historical contents" : "",
    s.github_pr ? `Status retrieved ${s.github_pr.fetched_at}` : "",
    s.commit?.path,
    updated ? "Updated since this message" : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <article
      aria-label={`${kind}: ${title}`}
      title={details}
      style={{
        position: "relative",
        width: "fit-content",
        maxWidth: "min(520px, 100%)",
        minWidth: 0,
        boxSizing: "border-box",
        marginTop: 6,
        border: `1px solid ${UI_COLORS.border}`,
        borderInlineStart: `3px solid ${theme?.color ?? UI_COLORS.border}`,
        borderRadius: 8,
        background: theme?.accent_color
          ? `linear-gradient(120deg, color-mix(in srgb, ${theme.accent_color} 10%, ${UI_COLORS.surface}), ${UI_COLORS.surface})`
          : `linear-gradient(120deg, ${UI_COLORS.surface}, ${UI_COLORS.inset})`,
        color: UI_COLORS.text,
      }}
    >
      {open && (
        <Button
          type="text"
          aria-label={`Open artifact: ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            borderRadius: 7,
          }}
        />
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          pointerEvents: "none",
          minWidth: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            flex: "0 0 48px",
            width: 48,
            height: 48,
            display: "grid",
            placeItems: "center",
            borderRadius: 6,
            background: UI_COLORS.surface,
            fontSize: 22,
          }}
        >
          {hasThumbnail ? (
            <Suspense
              fallback={<Icon name={(theme?.icon || icon) as IconName} />}
            >
              <Thumbnail
                imageBlob={theme?.image_blob}
                path={s.file?.path}
                projectId={projectId}
                title={title}
              />
            </Suspense>
          ) : (
            <Icon name={(theme?.icon || icon) as IconName} />
          )}
        </span>
        <span style={{ minWidth: 0, flex: "1 1 auto", lineHeight: 1.45 }}>
          <strong
            style={{
              display: "block",
              fontSize: 14,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </strong>
          <span
            style={{
              display: "block",
              fontSize: 12,
              color: UI_COLORS.secondary,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {s.file || s.commit ? (
              <code style={{ fontSize: "inherit" }}>{metadata}</code>
            ) : (
              metadata || kind
            )}
            {updated && <span> · Updated</span>}
          </span>
        </span>
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
              size="small"
              aria-label={`More options for ${title}`}
              style={{
                pointerEvents: "auto",
                flexShrink: 0,
                position: "relative",
              }}
              onClick={(e) => e.stopPropagation()}
              icon={<Icon name="ellipsis" />}
            />
          </Dropdown>
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
