import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// The screens never use the browser's own dialogs; if one slips in, the test fails loudly.
window.confirm = vi.fn(() => {
  throw new Error('window.confirm was used; use the Confirm dialog instead.');
});
window.prompt = vi.fn(() => {
  throw new Error('window.prompt was used; use an inline field instead.');
});
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  localStorage.clear();
});
