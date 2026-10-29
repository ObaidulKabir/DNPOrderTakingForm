import { describe, expect, it } from 'vitest';
import { FixedClock, SystemClock } from '../../src/domain/clock.js';
import { JsonCsvDataRepository } from '../../src/repositories/JsonCsvDataRepository.js';
import { NlpExtractionService } from '../../src/services/NlpExtractionService.js';

describe('Clock & NlpExtractionService', () => {
  const service = new NlpExtractionService();
  const fixedNow = new Date('2026-10-29T12:00:00.000Z');

  it('SystemClock and FixedClock return expected Date instances', () => {
    const sys = new SystemClock();
    expect(sys.now()).toBeInstanceOf(Date);

    const fc = new FixedClock('2026-10-29T10:00:00.000Z');
    expect(fc.now().toISOString()).toBe('2026-10-29T10:00:00.000Z');
    fc.setNow(new Date('2026-10-30T15:30:00.000Z'));
    expect(fc.now().toISOString()).toBe('2026-10-30T15:30:00.000Z');
    fc.setNow('2026-10-31T08:00:00.000Z');
    expect(fc.now().toISOString()).toBe('2026-10-31T08:00:00.000Z');
  });

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

  it('parses morning, afternoon, evening, 12am, and 12pm relative deadlines', () => {
    const morning = service.parseDeadline('tomorrow morning', fixedNow);
    const afternoon = service.parseDeadline('today afternoon', fixedNow);
    const evening = service.parseDeadline('tonight evening', fixedNow);
    const midnight = service.parseDeadline('tomorrow 12am', fixedNow);
    const noon = service.parseDeadline('today 12pm', fixedNow);
    const noTime = service.parseDeadline('tomorrow', fixedNow);
    const invalid = service.parseDeadline('next week sometime', fixedNow);

    expect(morning?.getHours()).toBe(11);
    expect(afternoon?.getHours()).toBe(16);
    expect(evening?.getHours()).toBe(19);
    expect(midnight?.getHours()).toBe(0);
    expect(noon?.getHours()).toBe(12);
    expect(noTime).toBeNull();
    expect(invalid).toBeNull();
  });

  it('detects products and extracts flyer and roller banner attributes', async () => {
    const repo = new JsonCsvDataRepository();
    const products = await repo.getProducts();

    expect(service.detectProductFromText('some text', [])).toBeUndefined();

    // Flyer with single-sided and single stock + mileage= format
    const flyerSpec = service.createInitialSpec(undefined, products[1]);
    const flyerExtracted = service.extractFromText(
      '500 A6 flyers, single-sided, 170gsm, print-ready artwork, mileage: 4.2, E1 3NL',
      flyerSpec,
      fixedNow,
      products
    );
    expect(flyerExtracted.productId).toBe('flyers-leaflets');
    expect(flyerExtracted.size).toBe('A6');
    expect(flyerExtracted.attributes?.sides).toBe('Single-sided');
    expect(flyerExtracted.attributes?.stock).toBe('170gsm Silk');
    expect(flyerExtracted.artwork).toBe('Ready');
    expect(flyerExtracted.devMiles).toBe(4.2);
    // Rejects print spec right before postcode as address
    expect(flyerExtracted.address).toBeNull();

    // Flyer with double-sided
    const flyerDouble = service.extractFromText(
      '250 flyers double-sided',
      flyerSpec,
      fixedNow,
      products
    );
    expect(flyerDouble.attributes?.sides).toBe('Double-sided');

    // Roller banner with premium teardrop base and 1000mm width
    const bannerSpec = service.createInitialSpec(undefined, products[2]);
    const bannerExtracted = service.extractFromText(
      '2 x 1000mm roller banners with premium teardrop base',
      bannerSpec,
      fixedNow,
      products
    );
    expect(bannerExtracted.productId).toBe('roller-banners');
    expect(bannerExtracted.quantity).toBe(2);
    expect(bannerExtracted.size).toBe('1000mm × 2000mm');
    expect(bannerExtracted.attributes?.cassette).toBe('Premium Teardrop Base');

    // Roller banner with standard base
    const bannerStd = service.extractFromText(
      '3 roller banners with standard base',
      bannerSpec,
      fixedNow,
      products
    );
    expect(bannerStd.attributes?.cassette).toBe('Standard Base');

    // getSpecAttr & setSpecAttr edge cases
    expect(service.getSpecAttr(bannerStd, 'nonexistent')).toBeNull();
    service.setSpecAttr(bannerStd, 'customField', 'val1');
    expect(service.getSpecAttr(bannerStd, 'customField')).toBe('val1');

    const noAttrs = { ...service.createInitialSpec(), attributes: undefined };
    service.setSpecAttr(noAttrs, 'size', 'A5');
    expect(noAttrs.size).toBe('A5');
    expect(
      service.getSpecAttr({ ...service.createInitialSpec(), size: '', attributes: { size: 'A6' } }, 'size')
    ).toBe('A6');

    expect(service.detectProductFromText('saddle stitched booklets please', products)?.id).toBe(
      'saddle-stitched-booklets'
    );
    expect(service.createInitialSpec().productId).toBe('saddle-stitched-booklets');

    const bothSides = service.extractFromText('flyers both sides', flyerSpec, fixedNow, products);
    expect(bothSides.attributes?.sides).toBe('Double-sided');

    const banner800 = service.extractFromText('1 x 800mm pull-up banner', bannerSpec, fixedNow, products);
    expect(banner800.size).toBe('800mm × 2000mm');
  });
});
