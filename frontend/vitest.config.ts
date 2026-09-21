import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Component tests.
 *
 * These exist because five consecutive slices shipped a user-interface defect
 * that the 126 API tests could not see: a picker drawn from the wrong list,
 * delegated authority never reaching the screen, controls offered on a
 * finalised matter, a stale version label, a selection silently discarded by a
 * re-render. Every one was found by hand in a browser, and two were nearly
 * missed.
 *
 * The API client is mocked here on purpose. The question these tests answer is
 * "given this state, does the screen offer the right controls to the right
 * person" — which is where the defects were. What the server permits is already
 * covered, exhaustively, by the integration suite.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.tsx'],
  },
});
