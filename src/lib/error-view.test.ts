// Unit tests for the 500 page's incident-slip derivations.

import { describe, it, expect } from 'vitest';
import { formatIncidentWhen, incidentRows, incidentText } from './error-view';

const AT = new Date('2026-08-26T14:08:31Z');
const UTC = { timeZone: 'UTC' };

describe('formatIncidentWhen', () => {
  it('renders the design\'s date · 24h-time shape', () => {
    expect(formatIncidentWhen(AT, UTC)).toBe('Aug 26, 2026 · 14:08');
  });

  it('pads a single-digit hour rather than dropping the leading zero', () => {
    expect(formatIncidentWhen(new Date('2026-08-26T04:05:00Z'), UTC)).toBe('Aug 26, 2026 · 04:05');
  });
});

describe('incidentRows', () => {
  it('carries every fact when all are present', () => {
    expect(incidentRows({ reference: 'e7f2-91ac-4d', when: AT, where: '/programs/x' }, UTC)).toEqual([
      { k: 'Reference', v: 'e7f2-91ac-4d' },
      { k: 'When', v: 'Aug 26, 2026 · 14:08' },
      { k: 'Where', v: '/programs/x' },
    ]);
  });

  it('omits the digest row for a client-side crash rather than rendering it blank', () => {
    const rows = incidentRows({ where: '/programs/x' }, UTC);
    expect(rows.map((r) => r.k)).toEqual(['Where']);
  });

  it('omits When until the client has supplied a timestamp', () => {
    const rows = incidentRows({ reference: 'abc', when: null, where: '/' }, UTC);
    expect(rows.map((r) => r.k)).toEqual(['Reference', 'Where']);
  });
});

describe('incidentText', () => {
  it('renders one "key: value" per line for the clipboard and the mail body', () => {
    expect(incidentText([{ k: 'Reference', v: 'abc' }, { k: 'Where', v: '/x' }])).toBe(
      'Reference: abc\nWhere: /x'
    );
  });
});
