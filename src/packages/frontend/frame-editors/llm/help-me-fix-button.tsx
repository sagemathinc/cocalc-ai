import { Button, Space } from "antd";
import React from "react";
import { defineMessage, useIntl } from "react-intl";

import { AIAvatar, RawPrompt } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import PopconfirmKeyboard from "@cocalc/frontend/components/popconfirm-keyboard";

const messages = {
  buttonText: defineMessage({
    id: "frame-editors.llm.help-me-fix-button.button-text",
    defaultMessage:
      "{isHint, select, true {Ask Agent for a Hint...} other {Fix with Agent...}}",
    description: "Button text for agent debugging actions - hint vs fix",
  }),
  okText: defineMessage({
    id: "frame-editors.llm.help-me-fix-button.ok-text",
    defaultMessage:
      "{isHint, select, true {Ask Agent [Return]} other {Send to Agent [Return]}}",
    description:
      "Confirmation button text in the agent debugging dialog - hint vs fix",
  }),
  title: defineMessage({
    id: "frame-editors.llm.help-me-fix-button.title",
    defaultMessage:
      "{isHint, select, true {Ask Agent for a debugging hint} other {Ask Agent to fix this problem}}",
    description: "Title text in the agent debugging dialog - hint vs fix",
  }),
};

interface HelpMeFixButtonProps {
  mode: "hint" | "solution";
  inputText: string;
  size?: any;
  style?: React.CSSProperties;
  gettingHelp: boolean;
  onConfirm: () => void;
}

export default function HelpMeFixButton({
  mode,
  inputText,
  size,
  style,
  gettingHelp,
  onConfirm,
}: HelpMeFixButtonProps) {
  const intl = useIntl();
  const isHint = mode === "hint";
  const title = intl.formatMessage(messages.title, { isHint });
  const buttonText = intl.formatMessage(messages.buttonText, { isHint });
  const okText = intl.formatMessage(messages.okText, { isHint });
  const buttonIcon = isHint ? "lightbulb" : "wrench";
  const okIcon = isHint ? "lightbulb" : "paper-plane";

  return (
    <PopconfirmKeyboard
      icon={<AIAvatar size={20} />}
      title={title}
      description={() => (
        <div
          style={{
            width: "550px",
            overflow: "auto",
            maxWidth: "90vw",
            maxHeight: "400px",
          }}
        >
          The following context will be sent to the agent:
          <RawPrompt input={inputText} />
        </div>
      )}
      okText={
        <>
          <Icon name={okIcon} /> {okText}
        </>
      }
      onConfirm={onConfirm}
    >
      <Button size={size} style={style} disabled={gettingHelp}>
        <Space>
          <Icon name={buttonIcon} />
          {buttonText}
        </Space>
      </Button>
    </PopconfirmKeyboard>
  );
}
