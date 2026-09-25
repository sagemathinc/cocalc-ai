import { Button, Popover } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";

export default function FundingHelp({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Popover
      trigger="click"
      title={title}
      content={<div style={{ maxWidth: "min(340px, 75vw)" }}>{children}</div>}
    >
      <Button
        type="text"
        size="small"
        aria-label={`About ${title.toLowerCase()}`}
        icon={<QuestionCircleOutlined aria-hidden />}
      />
    </Popover>
  );
}
