import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['server/test/**/*.test.ts', 'shared/test/**/*.test.ts'], environment: 'node' } });
