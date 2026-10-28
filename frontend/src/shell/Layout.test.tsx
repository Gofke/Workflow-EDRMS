import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, renderPage, server } from '../test/harness';
import { Layout } from './Layout';

const menu = async () => {
  const rail = await screen.findByRole('complementary', { name: 'Hoofdmenu' });
  return within(within(rail).getByRole('navigation'))
    .getAllByRole('link')
    .map((a) => a.textContent?.replace(/\d+$/, '').trim());
};

/** The menu follows the role: no one is shown a door that would only say "not permitted". */
describe('Main menu by role', () => {
  it('gives support staff the daily work, without management, archive decisions or administration', async () => {
    server(me(['SUPPORT_STAFF']), {});
    renderPage(<Layout><p>inhoud</p></Layout>);
    const items = await menu();
    expect(items).toEqual(expect.arrayContaining(['Mijn werk', 'Post', 'Zaken', 'Taken', 'Beoordelen', 'Zoeken', 'Assistent', 'Delegaties', 'Help']));
    expect(items).not.toContain('Bestuurlijk overzicht');
    expect(items).not.toContain('Beheer');
    expect(items).not.toContain('Logboek en integriteit');
  });

  it('gives the system administrator administration and the log, but no post, matters or tasks', async () => {
    server(me(['SYS_ADMIN']), {});
    renderPage(<Layout><p>inhoud</p></Layout>);
    const items = await menu();
    expect(items).toEqual(expect.arrayContaining(['Beheer', 'Logboek en integriteit', 'Help']));
    for (const business of ['Post', 'Zaken', 'Taken', 'Mijn werk', 'Assistent']) expect(items).not.toContain(business);
  });

  it('gives the auditor the log and the archive register, read-only, and nothing else', async () => {
    server(me(['AUDITOR']), {});
    renderPage(<Layout><p>inhoud</p></Layout>);
    const items = await menu();
    expect(items.sort()).toEqual(['Archief', 'Help', 'Logboek en integriteit'].sort());
    expect(screen.queryByRole('button', { name: /Vraag de assistent/ })).not.toBeInTheDocument();
  });

  it('gives the Minister the management overview and reports', async () => {
    server(me(['MINISTER']), {});
    renderPage(<Layout><p>inhoud</p></Layout>);
    const items = await menu();
    expect(items).toEqual(expect.arrayContaining(['Bestuurlijk overzicht', 'Rapporten', 'Archief', 'Logboek en integriteit']));
    expect(items).not.toContain('Beheer');
  });
});
