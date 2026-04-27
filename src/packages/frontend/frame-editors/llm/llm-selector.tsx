/*
 *  This file is part of CoCalc: Copyright © 2024 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import {
  LLM_USERNAMES,
  fromCustomOpenAIModel,
  fromOllamaModel,
  isCustomOpenAI,
  isOllamaLLM,
  isUserDefinedModel,
  model2service,
  type LanguageModel,
} from "@cocalc/util/db-schema/llm-utils";
import { getUserDefinedLLMByModel } from "./use-userdefined-llm";

export function modelToName(model: LanguageModel): string {
  if (isOllamaLLM(model)) {
    const ollama = redux.getStore("customize").get("ollama")?.toJS() ?? {};
    const config = ollama[fromOllamaModel(model)];
    return config ? config.display : `Ollama ${model}`;
  }

  if (isCustomOpenAI(model)) {
    const customOpenAI =
      redux.getStore("customize").get("custom_openai")?.toJS() ?? {};
    const config = customOpenAI[fromCustomOpenAIModel(model)];
    return config ? config.display : `OpenAI (custom) ${model}`;
  }

  if (isUserDefinedModel(model)) {
    return getUserDefinedLLMByModel(model)?.display ?? model;
  }

  return LLM_USERNAMES[model] ?? model;
}

export function modelToMention(model: LanguageModel): string {
  const id = isUserDefinedModel(model) ? model : model2service(model);
  return `<span class="user-mention" account-id=${id} >@${modelToName(
    model,
  )}</span>`;
}
