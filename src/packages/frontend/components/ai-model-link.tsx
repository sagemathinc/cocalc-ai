import { LanguageModel, model2vendor } from "@cocalc/util/db-schema/ai-models";
import { modelDisplayName } from "../frame-editors/ai/model-names";
import { A } from "./A";

export function AIModelLink({ model }: { model: LanguageModel }) {
  return <A href={model2vendor(model).url}>{modelDisplayName(model)}</A>;
}
