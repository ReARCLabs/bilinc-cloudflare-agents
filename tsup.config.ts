import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/tools.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: false,
  target: 'es2022',
});
