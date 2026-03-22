import { Button, Space } from "antd";
import React from "react";
import { defineMessage, useIntl } from "react-intl";

import { AIAvatar, RawPrompt } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import PopconfirmKeyboard from "@cocalc/frontend/components/popconfirm-keyboard";
import { LLMCostEstimation } from "@cocalc/frontend/misc/llm-cost-estimation";
import LLMSelector, { modelToName } from "./llm-selector";

const messages = {
  buttonText: defineMessage({
    id: "frame-editors.llm.help-me-fix-button.button-text",
    defaultMessage:
      "{isHint, select, true {Ask Codex for a Hint...} other {Fix with Codex...}}",
    description: "Button text for Codex debugging actions - hint vs fix",
  }),
  okText: defineMessage({
    id: "frame-editors.llm.help-me-fix-button.ok-text",
    defaultMessage:
      "{isHint, select, true {Ask Codex [Return]} other {Send to Codex [Return]}}",
    description:
      "Confirmation button text in the Codex debugging dialog - hint vs fix",
  }),
  title: defineMessage({
    id: "frame-editors.llm.help-me-fix-button.title",
    defaultMessage:
      "{isHint, select, true {Ask Codex for a debugging hint} other {Ask Codex to fix this problem}}",
    description: "Title text in the Codex debugging dialog - hint vs fix",
  }),
};

interface HelpMeFixButtonProps {
  mode: "hint" | "solution";
  model: string;
  setModel: (model: string) => void;
  project_id: string;
  inputText: string;
  tokens: number;
  size?: any;
  style?: React.CSSProperties;
  gettingHelp: boolean;
  onConfirm: () => void;
}

export default function HelpMeFixButton({
  mode,
  model,
  setModel,
  project_id,
  inputText,
  tokens,
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
      title={
        <>
          {title}{" "}
          <LLMSelector
            model={model}
            setModel={setModel}
            project_id={project_id}
          />
        </>
      }
      description={() => (
        <div
          style={{
            width: "550px",
            overflow: "auto",
            maxWidth: "90vw",
            maxHeight: "400px",
          }}
        >
          The following will be sent to {modelToName(model)}:
          <RawPrompt input={inputText} />
          <LLMCostEstimation
            model={model}
            tokens={tokens}
            type="secondary"
            paragraph
          />
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
