/* CoCalc: Copyright © 2026 SageMath, Inc. License: MS-RSL. */
import type { PickedAttachment } from "./attachments";

export async function pickCameraPhoto(): Promise<PickedAttachment[]> {
  const ImagePicker = await import("expo-image-picker");
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error("Allow camera access in Settings to take a photo.");
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    quality: 0.85,
  });
  return result.canceled
    ? []
    : result.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.fileName || "photo.jpg",
        mimeType: asset.mimeType,
        size: asset.fileSize,
      }));
}

export async function pickLibraryPhotos(): Promise<PickedAttachment[]> {
  const ImagePicker = await import("expo-image-picker");
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    quality: 0.85,
  });
  return result.canceled
    ? []
    : result.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.fileName || "photo.jpg",
        mimeType: asset.mimeType,
        size: asset.fileSize,
      }));
}

export async function pickFiles(): Promise<PickedAttachment[]> {
  const DocumentPicker = await import("expo-document-picker");
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: true,
  });
  return result.canceled
    ? []
    : result.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
      }));
}
