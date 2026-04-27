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
  model2service,
  type LanguageModel,
} from "@cocalc/util/db-schema/llm-utils";

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

  return LLM_USERNAMES[model] ?? model;
}

export function modelToMention(model: LanguageModel): string {
  return `<span class="user-mention" account-id=${model2service(
    model,
  )} >@${modelToName(model)}</span>`;
}
