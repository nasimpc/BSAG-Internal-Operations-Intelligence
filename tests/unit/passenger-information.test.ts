import { describe, expect, it } from 'vitest';

import { InputError } from '../../src/shared/dates.js';
import { draftPassengerInformation } from '../../src/services/passenger-information.js';

describe('draftPassengerInformation', () => {
  it('sorts unique line labels, strips HTML, normalizes whitespace, and keeps app copy within 240 characters', () => {
    const result = draftPassengerInformation({
      line_ids: ['4', '1', '4'],
      issue_summary:
        '  <strong>Roadworks</strong>   may affect the   eastern corridor tomorrow morning.  ',
      channel: 'app',
    });

    expect(result.channel).toBe('app');
    expect(result.text).toContain('Lines 1, 4');
    expect(result.text).toContain('may be affected');
    expect(result.text).not.toContain('<strong>');
    expect(result.text).not.toMatch(/\s{2,}/u);
    expect(result.text.length).toBeLessThanOrEqual(240);
    expect(result.character_count).toBe(result.text.length);
    expect(result.manual_edit_required).toBe(false);
  });

  it('drops optional advisory text before truncating essential app copy', () => {
    const result = draftPassengerInformation({
      line_ids: ['6'],
      issue_summary:
        'Major roadworks are expected across the corridor. '.repeat(4),
      channel: 'app',
    });

    expect(result.channel).toBe('app');
    expect(result.text.length).toBeLessThanOrEqual(240);
    expect(result.manual_edit_required).toBe(false);
    expect(result.text).not.toContain(
      'Check the latest updates before travel.',
    );
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'SUMMARY_TRUNCATED',
      }),
    ]);
  });

  it('keeps stop messages within 160 characters and marks manual edit required when essential content cannot fit', () => {
    const result = draftPassengerInformation({
      line_ids: ['1', '4', '6', '8', '10', '24', '25', '26', '27', '28'],
      issue_summary:
        'Roadworks may affect services between Hauptbahnhof, Domsheide, Weserpark, and Flughafen Bremen throughout the morning peak.',
      channel: 'stop',
    });

    expect(result.channel).toBe('stop');
    expect(result.text.length).toBeLessThanOrEqual(160);
    expect(result.character_count).toBe(result.text.length);
    expect(result.text).toContain('may be affected');
    expect(result.manual_edit_required).toBe(true);
  });

  it('compresses stop copy when the line label nearly consumes the channel limit', () => {
    const result = draftPassengerInformation({
      line_ids: Array.from({ length: 45 }, (_, index) => String(index + 1)),
      issue_summary: 'Expect disruption.',
      channel: 'stop',
    });

    expect(result.channel).toBe('stop');
    expect(result.text.length).toBeLessThanOrEqual(160);
    expect(result.manual_edit_required).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'MANUAL_EDIT_REQUIRED',
      }),
    ]);
  });

  it('renders a web heading and two concise paragraphs', () => {
    const result = draftPassengerInformation({
      line_ids: ['6'],
      issue_summary: 'Roadworks may affect services near Flughafen Bremen.',
      channel: 'web',
    });

    const sections = result.text.split('\n\n');

    expect(result.channel).toBe('web');
    expect(sections).toHaveLength(3);
    expect(sections[0]).toBe('# Service update for Line 6');
    expect(sections[1]).toContain('may be affected');
    expect(sections[2]).toContain('Check the latest updates before travel.');
    expect(result.manual_edit_required).toBe(false);
  });

  it('rejects empty line IDs and empty or oversized issue summaries', () => {
    expect(() =>
      draftPassengerInformation({
        line_ids: [' ', ''],
        issue_summary: 'Roadworks may affect service.',
        channel: 'app',
      }),
    ).toThrow(InputError);
    expect(() =>
      draftPassengerInformation({
        line_ids: ['4'],
        issue_summary: '   ',
        channel: 'app',
      }),
    ).toThrow(InputError);
    expect(() =>
      draftPassengerInformation({
        line_ids: ['4'],
        issue_summary: 'x'.repeat(2001),
        channel: 'app',
      }),
    ).toThrow(InputError);
  });
});
