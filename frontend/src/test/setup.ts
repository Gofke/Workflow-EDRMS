import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom has no window.confirm; every destructive control in this application
// asks for confirmation, so the tests need it to answer.
window.confirm = vi.fn(() => true);
