import { defineConfig } from 'tsdown';
import { readFileSync } from 'node:fs';
import 'varlock/auto-load';
import { ENV } from 'varlock/env';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: {
    index: './src/index.ts',
    cli: './src/cli.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  loader: {
    '.md': 'text',
  },
  define: {
    __BUMPY_VERSION__: JSON.stringify(pkg.version),
    __BUMPY_WEBSITE_URL__: JSON.stringify(ENV.BUMPY_WEBSITE_URL),
  },
});
