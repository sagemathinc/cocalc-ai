import { LanguageModel, model2vendor } from "@cocalc/util/db-schema/llm-utils";
import { modelDisplayName } from "../frame-editors/ai/model-names";
import { A } from "./A";

export function LLMNameLink({ model }: { model: LanguageModel }) {
  return <A href={model2vendor(model).url}>{modelDisplayName(model)}</A>;
}
