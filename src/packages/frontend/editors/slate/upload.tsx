/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Transforms } from "slate";
import { SlateEditor } from "./editable-markdown";
import { useEffect, useMemo, useRef } from "react";
import { Dropzone, BlobUpload } from "@cocalc/frontend/file-upload";
import { getFocus } from "./format/commands";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import {
  initialPastedImageDimensions,
  pastedBlobFilename,
  reportSlateUploadError,
} from "./upload-utils";
import { alert_message } from "@cocalc/frontend/alerts";

async function loadImageDimensions(
  src: string | undefined,
): Promise<{ naturalWidth: number; naturalHeight: number } | undefined> {
  const resolved = `${src ?? ""}`.trim();
  if (!resolved || typeof Image === "undefined") return undefined;
  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      });
    img.onerror = () => resolve(undefined);
    img.src = resolved;
  });
}

export default function useUpload(
  editor: SlateEditor,
  body: React.JSX.Element,
  callbacks: { onUploadStart?: () => void; onUploadEnd?: () => void } = {},
): React.JSX.Element {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const pending = useRef(new Set<unknown>());
  const mounted = useRef(true);
  const finish = (file) => {
    if (pending.current.delete(file.upload?.uuid ?? file)) {
      callbacksRef.current.onUploadEnd?.();
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const _ of pending.current) callbacksRef.current.onUploadEnd?.();
      pending.current.clear();
    };
  }, []);
  const dropzoneRef = useRef<Dropzone>(null);
  const { actions, project_id, path } = useFrameContext();
  const actionsRef = useRef<any>(actions);
  actionsRef.current = actions;
  const pathRef = useRef<string>(path);
  pathRef.current = path;

  useEffect(() => {
    const openFilePicker = () => dropzoneRef.current?.hiddenFileInput?.click();
    editor.openFilePicker = openFilePicker;
    return () => {
      if (editor.openFilePicker === openFilePicker)
        delete editor.openFilePicker;
    };
  }, [editor]);

  // We setup the slate "plugin" change to insertData here exactly once when
  // the component is mounted, because otherwise we would have to save
  // the dropzoneRef as an attribute on editor, which would make it not JSON-able.
  // Also, this simplifies using upload in editable-markdown.
  useEffect(() => {
    const { insertData } = editor;

    editor.insertData = (data) => {
      if (dropzoneRef?.current == null) {
        // fallback
        insertData(data);
        return;
      }
      const items = data.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item?.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file != null) {
            const blob = file.slice(0, -1, item.type);
            const uploadFile = new File([blob], pastedBlobFilename(item.type), {
              type: item.type,
            });
            (uploadFile as any)._slateUploadGeneration =
              (editor as any).__uploadGeneration ?? 0;
            dropzoneRef?.current?.addFile(uploadFile);
          }
          return; // what if more than one ?
        }
      }
      insertData(data);
    };
  }, []);

  // NOTE: when updloadEventHandlers function changes the FileUploadWrapper doesn't properly update
  // to reflect that (it's wrapping a third party library).  (For some reason this wasn't an issue with
  // React 17, but is with React 18.) This is why we store what updloadEventHandlers
  // depends on in a ref and only create it once.
  const updloadEventHandlers = useMemo(() => {
    return {
      addedfile: (file) => {
        const key = file.upload?.uuid ?? file;
        if (!pending.current.has(key)) {
          pending.current.add(key);
          callbacksRef.current.onUploadStart?.();
        }
      },
      canceled: finish,
      error: (file, message) => {
        finish(file);
        reportSlateUploadError(actionsRef.current, message, alert_message);
      },
      sending: ({ name }) => {
        actionsRef.current?.set_status?.(`Uploading ${name}...`);
      },
      complete: async (file) => {
        try {
          actionsRef.current?.set_status?.("");
          const { url } = file;
          if (!url) {
            // probably an error
            return;
          }
          const uploadGeneration =
            file?.upload?.chunks?.[0]?.file?._slateUploadGeneration;
          const currentUploadGeneration =
            (editor as any).__uploadGeneration ?? 0;
          if (
            uploadGeneration != null &&
            uploadGeneration !== currentUploadGeneration
          ) {
            return;
          }
          let node;
          const { height, upload } = file;
          const type = upload.chunks[0]?.file.type;
          if (!height && !type?.startsWith("image")) {
            node = {
              type: "link",
              isInline: true,
              children: [{ text: upload.filename ? upload.filename : "file" }],
              url,
            } as const;
          } else {
            const dimensions = initialPastedImageDimensions({
              filename: upload?.filename,
              ...(await loadImageDimensions(file?.dataURL ?? url)),
              devicePixelRatio:
                typeof window === "undefined" ? 1 : window.devicePixelRatio,
            });
            node = {
              type: "image",
              isInline: true,
              isVoid: true,
              src: url,
              ...(dimensions ?? {}),
              children: [{ text: "" }],
            } as const;
          }
          if (!mounted.current) return;
          Transforms.insertFragment(editor, [node], {
            at: getFocus(editor),
          });
        } finally {
          finish(file);
        }
      },
    };
  }, []);

  return (
    <BlobUpload
      show_upload={false}
      className="smc-vfill"
      project_id={project_id}
      event_handlers={updloadEventHandlers}
      style={{ height: "100%", width: "100%" }}
      dropzone_ref={dropzoneRef}
    >
      {body}
    </BlobUpload>
  );
}
