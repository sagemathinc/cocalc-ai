declare module "*.png" {
  const value: string;
  export default value;
}

// "file?raw" imports are bundled as the file's text (rspack asset/source).
declare module "*?raw" {
  const content: string;
  export default content;
}
