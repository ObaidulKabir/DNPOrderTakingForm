import { describe, expect, it } from 'vitest';
import { NlpExtractionService } from '../../src/services/NlpExtractionService.js';

describe('NlpExtractionService', () => {
  const service = new NlpExtractionService();
  const fixedNow = new Date('2026-10-29T12:00:00.000Z');

  it('extracts all fields from the default PrintPilot demo prompt', () => {
    const initial = service.createInitialSpec();
    const prompt =
      '100 copies, A4 portrait, 20 pages, 350gsm cover, 170gsm inner, 39 Solent House, E1 3NL, 3.4 miles and Artwork Ready. Needed by tomorrow 10 am';

    const result = service.extractFromText(prompt, initial, fixedNow);

    expect(result.quantity).toBe(100);
    expect(result.size).toBe('A4');
    expect(result.orientation).toBe('Portrait');
    expect(result.pages).toBe(20);
    expect(result.cover).toBe('350gsm Silk');
    expect(result.inner).toBe('170gsm Silk');
    expect(result.address).toBe('39 Solent House');
    expect(result.postcode).toBe('E1 3NL');
    expect(result.devMiles).toBe(3.4);
    expect(result.artwork).toBe('Ready');
    expect(result.deadline).toBeTruthy();

    const dl = new Date(result.deadline!);
    expect(dl.getHours()).toBe(10);
    expect(dl.getMinutes()).toBe(0);
  });

  it('parses shorthand quantity like "50 x A5" and explicit delivery phrasing', () => {
    const initial = service.createInitialSpec();
    const prompt =
      'I need 50 x A5 landscape booklets, 16pp, artwork not ready, deliver to 10 Downing Street, SW1A 2AA today by 4:30pm';

    const result = service.extractFromText(prompt, initial, fixedNow);

    expect(result.quantity).toBe(50);
    expect(result.size).toBe('A5');
    expect(result.orientation).toBe('Landscape');
    expect(result.pages).toBe(16);
    expect(result.artwork).toBe('Not ready');
    expect(result.address).toBe('10 Downing Street');
    expect(result.postcode).toBe('SW1A 2AA');

    const dl = new Date(result.deadline!);
    expect(dl.getHours()).toBe(16);
    expect(dl.getMinutes()).toBe(30);
  });

  it('parses morning, afternoon, and evening relative deadlines', () => {
    const morning = service.parseDeadline('tomorrow morning', fixedNow);
    const afternoon = service.parseDeadline('today afternoon', fixedNow);
    const evening = service.parseDeadline('tonight evening', fixedNow);
    const invalid = service.parseDeadline('next week sometime', fixedNow);

    expect(morning?.getHours()).toBe(11);
    expect(afternoon?.getHours()).toBe(16);
    expect(evening?.getHours()).toBe(19);
    expect(invalid).toBeNull();
  });
});
