import { useState } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { useProjectHostAuthedUrl } from "@cocalc/frontend/project/use-project-host-authed-url";
import { viewerRawFileUrl } from "@cocalc/frontend/project/viewer-file-editor";

export function ThumbnailImage({
  src,
  title,
  size = 48,
}: {
  src?: string;
  title: string;
  size?: number;
}) {
  const [failed, setFailed] = useState<string>();
  return (
    <div
      style={{
        width: size,
        height: size,
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
          style={{ width: "100%", height: size, objectFit: "contain" }}
        />
      ) : (
        <span
          style={{
            fontSize: 10,
            lineHeight: 1.2,
            textAlign: "center",
            color: UI_COLORS.secondary,
          }}
        >
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
  size,
}: {
  path: string;
  projectId: string;
  title: string;
  size?: number;
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
  return <ThumbnailImage key={path} src={url} title={title} size={size} />;
}

export default function ArtifactThumbnail({
  imageBlob,
  path,
  projectId,
  title,
  size,
}: {
  imageBlob?: string | null;
  path?: string;
  projectId?: string;
  title: string;
  size?: number;
}) {
  if (imageBlob)
    return (
      <ThumbnailImage
        src={`${appBasePath}/blobs/theme-image.png?uuid=${encodeURIComponent(imageBlob)}`}
        title={title}
        size={size}
      />
    );
  if (path && projectId)
    return (
      <FileThumbnail
        key={`${projectId}:${path}`}
        path={path}
        projectId={projectId}
        title={title}
        size={size}
      />
    );
  return null;
}
