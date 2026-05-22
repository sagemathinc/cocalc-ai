/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Various logic depends on filename extensions, so it is good to centralize that to avoid
duplicating code.  What's below may be pretty dumb though (and we should use some
mimetype library)...
*/

import {
  codemirrorMode,
  defaultToRaw,
  hasSpecialViewer,
  hasViewer as hasViewerWithoutMedia,
  isCodemirror,
  isHTML,
  isImage,
  isMarkdown,
  isPDF,
} from "@cocalc/util/file-extensions";
import { VIDEO_EXTS, AUDIO_EXTS } from "./file-associations";

// https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video
const video = new Set(VIDEO_EXTS);
export const isVideo = (ext: string): boolean => video.has(ext);

const audio = new Set(AUDIO_EXTS);
export const isAudio = (ext: string): boolean => audio.has(ext);

export function hasViewer(ext: string): boolean {
  return hasViewerWithoutMedia(ext) || isVideo(ext) || isAudio(ext);
}

export {
  codemirrorMode,
  defaultToRaw,
  hasSpecialViewer,
  isCodemirror,
  isHTML,
  isImage,
  isMarkdown,
  isPDF,
};
