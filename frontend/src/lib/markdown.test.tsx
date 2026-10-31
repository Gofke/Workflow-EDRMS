import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Markdown, safeHref } from './markdown';

const show = (text: string) =>
  render(
    <MemoryRouter>
      <Markdown text={text} />
    </MemoryRouter>,
  );

describe('safe Markdown', () => {
  it('allows only internal paths and https links', () => {
    expect(safeHref('/zaken/123')).toEqual({ internal: true, href: '/zaken/123' });
    expect(safeHref('https://www.gov.sr')).toEqual({ internal: false, href: 'https://www.gov.sr' });
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example/x')).toBeNull();
    expect(safeHref('http://plain.example')).toBeNull();
    expect(safeHref('data:text/html,hi')).toBeNull();
  });

  it('renders lists, numbered lists, bold, italic and code', () => {
    const { container } = show('**Vet** en *schuin* en `code`\n\n1. een\n2. twee\n\n- a\n- b');
    expect(screen.getByText('Vet').tagName).toBe('STRONG');
    expect(screen.getByText('schuin').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
  });

  it('leaves codes with underscores alone', () => {
    const { container } = show('Meest gelogd: AI_QUESTION_ANSWERED en SIGN_IN_SUCCEEDED, maar _schuin_ wel.');
    expect(container.textContent).toContain('AI_QUESTION_ANSWERED en SIGN_IN_SUCCEEDED');
    expect(screen.getByText('schuin').tagName).toBe('EM');
  });

  it('renders a table', () => {
    const { container } = show('| Afdeling | Open |\n|---|---|\n| JZ | 4 |\n| VZ | 2 |');
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('never renders HTML from the text', () => {
    const { container } = show('<script>alert(1)</script><b onclick="x()">hi</b>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});
