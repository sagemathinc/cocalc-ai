import type {
  TasksHostServices,
  TasksMarkdownEditorProps,
  TasksMostlyStaticMarkdownProps,
  TasksMarkdownSurface,
  TasksStaticMarkdownProps,
} from "@cocalc/app-tasks";
import type { ComponentType } from "react";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import MostlyStaticMarkdown from "@cocalc/frontend/editors/slate/mostly-static-markdown";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import type { TaskActions } from "./actions";

export interface ReactTasksMarkdownSurface extends Omit<
  TasksMarkdownSurface,
  "MarkdownEditor" | "StaticMarkdown" | "MostlyStaticMarkdown"
> {
  MarkdownEditor: ComponentType<TasksMarkdownEditorProps>;
  StaticMarkdown: ComponentType<TasksStaticMarkdownProps>;
  MostlyStaticMarkdown: ComponentType<TasksMostlyStaticMarkdownProps>;
}

export const defaultTasksMarkdownSurface: ReactTasksMarkdownSurface = {
  MarkdownEditor:
    MarkdownInput as unknown as ComponentType<TasksMarkdownEditorProps>,
  StaticMarkdown:
    StaticMarkdown as unknown as ComponentType<TasksStaticMarkdownProps>,
  MostlyStaticMarkdown:
    MostlyStaticMarkdown as unknown as ComponentType<TasksMostlyStaticMarkdownProps>,
};

export function createTasksHostServices(
  actions: Pick<
    TaskActions,
    "enable_key_handler" | "disable_key_handler" | "save" | "undo" | "redo"
  >,
): TasksHostServices {
  return {
    enableKeyHandler() {
      actions.enable_key_handler();
    },
    disableKeyHandler() {
      actions.disable_key_handler();
    },
    save() {
      actions.save();
    },
    undo() {
      actions.undo();
    },
    redo() {
      actions.redo();
    },
  };
}
