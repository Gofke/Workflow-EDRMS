import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Working days in Suriname: Monday to Friday, minus the public holidays in the
 * public_holiday table. Deadlines, reminders and escalations count in working
 * days so a letter received before Divali does not lose a day to it.
 *
 * The holiday list is maintained by the administrator. The moveable holidays
 * (Holi Phagwah, Ied-ul-Fitr, Ied-ul-Adha, Divali, Chinese New Year, Easter)
 * are announced each year and must be confirmed there.
 */
@Injectable()
export class WorkingDaysService {
  private cache: { at: number; dates: Set<string> } | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async holidays(): Promise<Set<string>> {
    if (this.cache && Date.now() - this.cache.at < 10_000) return this.cache.dates;
    const rows: { d: string }[] = await this.dataSource.query(
      `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM public_holiday`,
    );
    this.cache = { at: Date.now(), dates: new Set(rows.map((r) => r.d)) };
    return this.cache.dates;
  }

  invalidate(): void {
    this.cache = null;
  }

  async isWorkingDay(date: string): Promise<boolean> {
    const h = await this.holidays();
    return isWeekday(date) && !h.has(date);
  }

  /** The date n working days after `from` (n may be 0: the next working day on or after). */
  async addWorkingDays(from: string, n: number): Promise<string> {
    const h = await this.holidays();
    let d = from;
    if (n === 0) {
      while (!isWeekday(d) || h.has(d)) d = addDays(d, 1);
      return d;
    }
    let left = n;
    while (left > 0) {
      d = addDays(d, 1);
      if (isWeekday(d) && !h.has(d)) left -= 1;
    }
    return d;
  }

  /**
   * Working days from `from` to `to`: positive when `to` is later. A deadline
   * today is 0; yesterday's deadline is -1 if yesterday was a working day.
   */
  async workingDaysBetween(from: string, to: string): Promise<number> {
    const h = await this.holidays();
    if (from === to) return 0;
    const forward = from < to;
    let d = from;
    let count = 0;
    while (d !== to) {
      d = addDays(d, forward ? 1 : -1);
      if (isWeekday(d) && !h.has(d)) count += 1;
      if (Math.abs(count) > 4000) break;
    }
    return forward ? count : -count;
  }
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isWeekday(date: string): boolean {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * Suriname's public holidays for 2026 and 2027, from published calendars
 * (11holidays.pages.dev for 2026, qppstudio.net for 2027). The moveable dates
 * must be confirmed against the Government's annual announcement; the
 * administrator can correct them on the holidays screen.
 */
export const SURINAME_HOLIDAYS: { date: string; name: string }[] = [
  { date: '2026-01-01', name: 'Nieuwjaarsdag' },
  { date: '2026-02-17', name: 'Chinees Nieuwjaar' },
  { date: '2026-03-03', name: 'Holi Phagwah' },
  { date: '2026-03-20', name: 'Ied-ul-Fitr' },
  { date: '2026-04-03', name: 'Goede Vrijdag' },
  { date: '2026-04-06', name: 'Tweede Paasdag' },
  { date: '2026-05-01', name: 'Dag van de Arbeid' },
  { date: '2026-05-27', name: 'Ied-ul-Adha' },
  { date: '2026-07-01', name: 'Keti Koti — Dag der Vrijheden' },
  { date: '2026-08-09', name: 'Dag der Inheemsen' },
  { date: '2026-10-10', name: 'Dag der Marrons' },
  { date: '2026-11-08', name: 'Divali' },
  { date: '2026-11-25', name: 'Onafhankelijkheidsdag (Srefidensi)' },
  { date: '2026-12-25', name: 'Eerste Kerstdag' },
  { date: '2026-12-26', name: 'Tweede Kerstdag' },
  { date: '2027-01-01', name: 'Nieuwjaarsdag' },
  { date: '2027-02-06', name: 'Chinees Nieuwjaar' },
  { date: '2027-03-09', name: 'Ied-ul-Fitr' },
  { date: '2027-03-22', name: 'Holi Phagwah' },
  { date: '2027-03-26', name: 'Goede Vrijdag' },
  { date: '2027-03-29', name: 'Tweede Paasdag' },
  { date: '2027-05-01', name: 'Dag van de Arbeid' },
  { date: '2027-05-16', name: 'Ied-ul-Adha' },
  { date: '2027-07-01', name: 'Keti Koti — Dag der Vrijheden' },
  { date: '2027-08-09', name: 'Dag der Inheemsen' },
  { date: '2027-10-10', name: 'Dag der Marrons' },
  { date: '2027-11-25', name: 'Onafhankelijkheidsdag (Srefidensi)' },
  { date: '2027-12-25', name: 'Eerste Kerstdag' },
  { date: '2027-12-26', name: 'Tweede Kerstdag' },
];
