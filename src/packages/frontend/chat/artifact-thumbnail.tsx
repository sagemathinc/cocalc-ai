import { useState } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { useProjectHostAuthedUrl } from "@cocalc/frontend/project/use-project-host-authed-url";
import { viewerRawFileUrl } from "@cocalc/frontend/project/viewer-file-editor";

export function ThumbnailImage({
  src,
  title,
}: {
  src?: string;
  title: string;
}) {
  const [failed, setFailed] = useState<string>();
  return (
    <div
      style={{
        height: 160,
        margin: "10px 0",
        borderRadius: 8,
        overflow: "hidden",
        background: UI_COLORS.inset,
        display: "grid",
        placeItems: "center",
      }}
    >
      {src && failed !== src ? (
        <img
          src={src}
          alt={`Preview of ${title}`}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(src)}
          style={{ width: "100%", height: 160, objectFit: "contain" }}
        />
      ) : (
        <span style={{ fontSize: 12, color: UI_COLORS.secondary }}>
          {failed ? "Preview unavailable" : "Preparing preview..."}
        </span>
      )}
    </div>
  );
}

function FileThumbnail({
  path,
  projectId,
  title,
}: {
  path: string;
  projectId: string;
  title: string;
}) {
  const { projectAccess } = useProjectContext();
  const url = useProjectHostAuthedUrl({
    project_id: projectId,
    url: viewerRawFileUrl({
      project_id: projectId,
      path,
      viewer: projectAccess?.role === "viewer",
    }),
  });
  return <ThumbnailImage key={path} src={url} title={title} />;
}

export default function ArtifactThumbnail({
  imageBlob,
  path,
  projectId,
  title,
}: {
  imageBlob?: string | null;
  path?: string;
  projectId?: string;
  title: string;
}) {
  if (imageBlob)
    return (
      <ThumbnailImage
        src={`${appBasePath}/blobs/theme-image.png?uuid=${encodeURIComponent(imageBlob)}`}
        title={title}
      />
    );
  if (path && projectId)
    return (
      <FileThumbnail
        key={`${projectId}:${path}`}
        path={path}
        projectId={projectId}
        title={title}
      />
    );
  return null;
}
