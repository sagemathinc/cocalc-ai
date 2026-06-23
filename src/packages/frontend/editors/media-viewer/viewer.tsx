/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Image viewer component -- for viewing standard image types.
*/

import { filename_extension } from "@cocalc/util/misc";

import { React, useCallback, useMemo, useState } from "../../app-framework";
import { Loading } from "@cocalc/frontend/components";
import { Path } from "@cocalc/frontend/frame-editors/frame-tree/path";
import { useProjectHostAuthedUrl } from "@cocalc/frontend/project/use-project-host-authed-url";
import { webapp_client } from "../../webapp-client";
import { MediaViewerButtonBar } from "./button-bar";
import { VIDEO_EXTS, IMAGE_EXTS, AUDIO_EXTS } from "../../file-associations";
import { useReloadFileWhenVisible } from "../viewer-file-hooks";

interface Props {
  project_id: string;
  path: string;
  actions?: { fs?: () => { stat?: (path: string) => Promise<any> } };
  is_visible?: boolean;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.2;

export const MediaViewer: React.FC<Props> = ({
  project_id,
  path,
  actions,
  is_visible,
}) => {
  // used to force reload when button explicitly clicked
  const [param, set_param] = useState<number>(0);
  const [imageZoom, setImageZoom] = useState(1);
  const [fitImage, setFitImage] = useState(true);
  const [naturalImageWidth, setNaturalImageWidth] = useState<
    number | undefined
  >(undefined);
  const mode = get_mode(path);
  const refresh = useCallback(() => set_param(Date.now()), []);
  const stat = useCallback(
    async (path: string) => {
      const fs = actions?.fs?.();
      if (typeof fs?.stat !== "function") {
        throw Error("project filesystem is not available");
      }
      return await fs.stat(path);
    },
    [actions],
  );

  useReloadFileWhenVisible({
    is_visible,
    path,
    stat,
    reload: refresh,
  });

  // the URL to the file:
  let url = webapp_client.project_client.read_file({
    project_id,
    path,
  });
  if (param) {
    url += `?param=${param}`; // this forces reload whenever refresh button clicked
  }
  const authedUrl = useProjectHostAuthedUrl({
    project_id,
    url,
  });

  const zoomControls = useMemo(() => {
    if (mode !== "image") return undefined;
    const setZoom = (zoom: number) => {
      setFitImage(false);
      setImageZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)));
    };
    return {
      fit: fitImage,
      zoom: imageZoom,
      zoomIn: () => setZoom(imageZoom * ZOOM_STEP),
      zoomOut: () => setZoom(imageZoom / ZOOM_STEP),
      reset: () => setZoom(1),
      fitToWidth: () => setFitImage(true),
    };
  }, [fitImage, imageZoom, mode]);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
      className={"smc-vfill"}
    >
      <Path project_id={project_id} path={path} />
      <MediaViewerButtonBar refresh={refresh} imageZoom={zoomControls} />
      <div
        style={{
          overflow: "auto",
          flex: "1 1 auto",
          minHeight: 0,
          marginTop: "1px",
          padding: "1px",
          borderTop: "1px solid lightgray",
          textAlign: "center",
          background: "black",
        }}
      >
        {authedUrl ? (
          <RenderMedia
            url={authedUrl}
            path={path}
            fitImage={fitImage}
            imageZoom={imageZoom}
            naturalImageWidth={naturalImageWidth}
            setNaturalImageWidth={setNaturalImageWidth}
          />
        ) : (
          <Loading theme="medium" />
        )}
      </div>
    </div>
  );
};

function get_mode(path: string): string {
  const ext = filename_extension(path).toLowerCase();
  if (VIDEO_EXTS.includes(ext)) {
    return "video";
  }
  if (IMAGE_EXTS.includes(ext)) {
    return "image";
  }
  if (AUDIO_EXTS.includes(ext)) {
    return "audio";
  }
  console.warn(`Unknown media extension ${ext}`);
  return "";
}

const RenderMedia: React.FC<{
  path: string;
  url: string;
  fitImage: boolean;
  imageZoom: number;
  naturalImageWidth?: number;
  setNaturalImageWidth: (width: number | undefined) => void;
}> = ({
  path,
  url,
  fitImage,
  imageZoom,
  naturalImageWidth,
  setNaturalImageWidth,
}) => {
  switch (get_mode(path)) {
    case "image":
      return (
        <img
          src={url}
          onLoad={(event) => {
            const width = event.currentTarget.naturalWidth;
            setNaturalImageWidth(width > 0 ? width : undefined);
          }}
          style={{
            maxWidth: fitImage ? "100%" : undefined,
            width: fitImage
              ? undefined
              : naturalImageWidth != null
                ? `${naturalImageWidth * imageZoom}px`
                : `${imageZoom * 100}%`,
            background: "white",
          }}
        />
      );
    case "video":
      return (
        <video
          src={url}
          style={{ maxWidth: "100%" }}
          controls={true}
          autoPlay={true}
          loop={true}
        />
      );
    case "audio":
      return <audio src={url} autoPlay={true} controls={true} loop={false} />;
    default:
      // should never happen
      return (
        <div style={{ color: "white", fontSize: "200%" }}>Unknown type</div>
      );
  }
};
