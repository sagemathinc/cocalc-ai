export type EntityTheme = {
  title: string;
  description: string;
  color: string | null;
  accent_color: string | null;
  icon: string | null;
  image_blob: string | null;
};

export type ThemeEditorDraft = {
  title: string;
  description: string;
  color: string | null;
  accent_color: string | null;
  icon: string;
  image_blob: string;
};

export type ThemeImageChoice = {
  blob: string;
  label?: string;
};

export function themeDraftFromTheme(
  theme: Partial<EntityTheme> | undefined | null,
  titleFallback = "",
): ThemeEditorDraft {
  return {
    title: `${theme?.title ?? ""}`.trim() || titleFallback,
    description: `${theme?.description ?? ""}`,
    color: theme?.color ?? null,
    accent_color: theme?.accent_color ?? null,
    icon: theme?.icon ?? "",
    image_blob: theme?.image_blob ?? "",
  };
}

export function themeFromDraft(draft: ThemeEditorDraft): EntityTheme {
  return {
    title: draft.title.trim(),
    description: draft.description,
    color: draft.color ?? null,
    accent_color: draft.accent_color ?? null,
    icon: draft.icon.trim() || null,
    image_blob: draft.image_blob.trim() || null,
  };
}
