import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: './index.ts',
    cli: './src/cli.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
});
