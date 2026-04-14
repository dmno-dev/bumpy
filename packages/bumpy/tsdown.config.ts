import { defineConfig } from 'tsdown';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: {
    index: './index.ts',
    cli: './src/cli.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  define: {
    __BUMPY_VERSION__: JSON.stringify(pkg.version),
  },
});
