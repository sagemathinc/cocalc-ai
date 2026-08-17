declare module "*.png" {
  const value: string;
  export default value;
}

declare namespace NodeJS {
  interface Require {
    ensure(
      dependencies: string[],
      callback: (require: Require) => void,
      errorCallback?: (error: Error) => void,
      chunkName?: string,
    ): void;
  }
}
