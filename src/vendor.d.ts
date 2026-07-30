// Ambient declarations for two dependencies that ship no types.
// Declared locally instead of pulling @types packages so `npm ci` in CI stays
// lean and the published package keeps zero extra devDependencies.

declare module "qrcode" {
  export function toString(
    text: string,
    options?: Record<string, unknown>
  ): Promise<string>;
  export function toDataURL(
    text: string,
    options?: Record<string, unknown>
  ): Promise<string>;
  export function toFile(
    path: string,
    text: string,
    options?: Record<string, unknown>
  ): Promise<void>;
  export function toBuffer(
    text: string,
    options?: Record<string, unknown>
  ): Promise<Buffer>;
  const _default: {
    toString: typeof toString;
    toDataURL: typeof toDataURL;
    toFile: typeof toFile;
    toBuffer: typeof toBuffer;
  };
  export default _default;
}

declare module "qrcode-terminal" {
  export function generate(
    text: string,
    options?: { small?: boolean },
    cb?: (ascii: string) => void
  ): void;
  const _default: { generate: typeof generate };
  export default _default;
}
