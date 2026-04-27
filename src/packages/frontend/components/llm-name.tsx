import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { modelDisplayName } from "@cocalc/frontend/frame-editors/ai/model-names";
import {
  LanguageModel,
  fromCustomOpenAIModel,
  fromOllamaModel,
  isCustomOpenAI,
  isLanguageModel,
  isOllamaLLM,
} from "@cocalc/util/db-schema/llm-utils";
import { LanguageModelVendorAvatar } from "./language-model-icon";

export function LLMModelName(
  props: Readonly<{ model: LanguageModel; size?: number }>,
) {
  const { model, size } = props;

  const ollama = useTypedRedux("customize", "ollama");
  const custom_openai = useTypedRedux("customize", "custom_openai");

  function renderTitle() {
    if (isOllamaLLM(model)) {
      const om = ollama?.get(fromOllamaModel(model));
      if (om) {
        return om.get("display") ?? `Ollama ${model}`;
      }
    }

    if (isCustomOpenAI(model)) {
      const coi = custom_openai?.get(fromCustomOpenAIModel(model));
      if (coi) {
        return coi.get("display") ?? `OpenAI (custom) ${model}`;
      }
    }

    if (isLanguageModel(model)) {
      return modelDisplayName(model);
    }

    return model;
  }

  return (
    <>
      <LanguageModelVendorAvatar
        model={model}
        size={size}
        style={{ marginRight: 0 }}
      />{" "}
      {renderTitle()}
    </>
  );
}
