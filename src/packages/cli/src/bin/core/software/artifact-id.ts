import {
  SOFTWARE_DEPLOY_COMPONENTS,
  type SoftwareBuildComponent,
  type SoftwareDeployComponent,
  type SoftwareGitMetadata,
} from "./types";

const TAG_RE = /^[A-Za-z0-9._-]+$/;

export function parseSoftwareBuildComponent(
  value: string,
): SoftwareBuildComponent {
  switch (value) {
    case "static":
    case "hub":
    case "project-host":
    case "project":
    case "tools":
    case "cli":
    case "launchpad":
    case "plus":
    case "star":
      return value;
    default:
      throw new Error(`unknown software build component: ${value}`);
  }
}

export function parseSoftwareDeployComponent(
  value: string,
): SoftwareDeployComponent {
  if (SOFTWARE_DEPLOY_COMPONENTS.includes(value as SoftwareDeployComponent)) {
    return value as SoftwareDeployComponent;
  }
  throw new Error(`unknown software deploy component: ${value}`);
}

export function validateSoftwareTag(tag: string): string {
  const trimmed = `${tag ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("software tag must not be empty");
  }
  if (!TAG_RE.test(trimmed)) {
    throw new Error(
      "software tag must contain only letters, numbers, dot, underscore, or dash",
    );
  }
  return trimmed;
}

export function compactTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(
    11,
    13,
  )}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export function compactMinuteTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(
    11,
    13,
  )}${iso.slice(14, 16)}Z`;
}

export function createSoftwareArtifactId({
  createdAt,
  git,
  tag,
}: {
  createdAt: Date;
  git: SoftwareGitMetadata;
  tag: string;
}): string {
  const timestamp = compactTimestamp(createdAt);
  const git8 = git.short.slice(0, 8) || git.commit.slice(0, 8);
  const suffix = git.dirty ? "-dirty" : "";
  return `${timestamp}-${git8}-${validateSoftwareTag(tag)}${suffix}`;
}

export function chooseGeneratedTag({
  createdAt,
  tagExists,
}: {
  createdAt: Date;
  tagExists: (tag: string) => boolean;
}): string {
  const candidates = [
    compactMinuteTimestamp(createdAt),
    compactTimestamp(createdAt),
  ];
  for (const candidate of candidates) {
    if (!tagExists(candidate)) {
      return candidate;
    }
  }
  const base = compactTimestamp(createdAt);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!tagExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`unable to generate unique software tag for ${base}`);
}
