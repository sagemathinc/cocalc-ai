/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Button bar for media viewer

For now we just pass in a single function and don't bother with actions/redux, etc.,
since there is no state or need for it...
*/

import { Icon } from "../../components";
import { Button } from "../../antd-bootstrap";
import { Space } from "antd";

interface Props {
  refresh: () => void;
  imageZoom?: {
    fit: boolean;
    zoom: number;
    zoomIn: () => void;
    zoomOut: () => void;
    reset: () => void;
    fitToWidth: () => void;
  };
}

export const MediaViewerButtonBar: React.FC<Props> = ({
  refresh,
  imageZoom,
}: Props) => {
  return (
    <Space wrap size={4} style={{ padding: "0 1px" }}>
      <Button
        title={"Reload this, showing the latest version on disk."}
        onClick={refresh}
      >
        <Icon name={"repeat"} /> Reload
      </Button>
      {imageZoom != null && (
        <>
          <Button title="Zoom out" onClick={imageZoom.zoomOut}>
            <Icon name="minus" /> Zoom
          </Button>
          <Button title="Show image at natural size" onClick={imageZoom.reset}>
            {imageZoom.fit ? "Fit" : `${Math.round(imageZoom.zoom * 100)}%`}
          </Button>
          <Button title="Zoom in" onClick={imageZoom.zoomIn}>
            <Icon name="plus" /> Zoom
          </Button>
          <Button
            title="Fit image to viewer width"
            onClick={imageZoom.fitToWidth}
          >
            Fit
          </Button>
        </>
      )}
    </Space>
  );
};
