import { defineConfig } from '@pandacss/dev';
import { createPreset } from '@park-ui/panda-preset';

export default defineConfig({
  preflight: true,
  presets: [createPreset()],
  include: ['./src/**/*.{ts,tsx}'],
  outdir: 'styled-system'
});
