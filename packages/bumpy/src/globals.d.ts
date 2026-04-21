// for local dev and runing tests, these are set by bunfig.toml
// at build time they are loaded via varlock and injected via tsdown

/**
 * current version number ("1.2.3") - pulled from package.json
 *
 * Injected at build time by tsdown, or via bunfig.toml when running from source
 * */
declare const __BUMPY_VERSION__: string;

declare module '*.md' {
  const content: string;
  export default content;
}
