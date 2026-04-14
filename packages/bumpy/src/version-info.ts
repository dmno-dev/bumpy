declare const __BUMPY_VERSION__: string | undefined;

/** Get the bumpy version. Injected at build time by tsdown, falls back to "dev" when running from source. */
export function getVersion(): string {
  return typeof __BUMPY_VERSION__ !== 'undefined' ? __BUMPY_VERSION__ : 'dev';
}
