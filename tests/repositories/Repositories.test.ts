import { describe, expect, it } from 'vitest';
import { InMemoryDataRepository } from '../../src/repositories/InMemoryDataRepository.js';
import { JsonCsvDataRepository } from '../../src/repositories/JsonCsvDataRepository.js';
import { PostgresDataRepository } from '../../src/repositories/PostgresDataRepository.js';
import { SqliteDataRepository } from '../../src/repositories/SqliteDataRepository.js';

describe('Dynamic Data Repositories (PostgreSQL Relational + JSONB, JsonCsv, InMemory, Sqlite)', () => {
  const jsonRepo = new JsonCsvDataRepository();

  it('loads all seeded datasets including multi-product catalog from JsonCsvDataRepository', async () => {
    const [products, capabilities, config, hrjJobs, dnpObs, route1Rows, bands, postcodes] =
      await Promise.all([
        jsonRepo.getProducts(),
        jsonRepo.getSupplierCapabilities(),
        jsonRepo.getBusinessConfig(),
        jsonRepo.getHrjHistoricalJobs(),
        jsonRepo.getDnpSellingObservations(),
        jsonRepo.getRoute1StandardPrices(),
        jsonRepo.getCourierDistanceBands(),
        jsonRepo.getPostcodeDistances(),
      ]);

    expect(products.length).toBe(3);
    expect(products.map((p) => p.id)).toEqual([
      'saddle-stitched-booklets',
      'flyers-leaflets',
      'roller-banners',
    ]);
    expect(capabilities.length).toBe(4);
    expect(config.productName).toBe('Saddle-stitched booklets');
    expect(hrjJobs.length).toBe(37);
    expect(dnpObs.length).toBe(37);
    expect(route1Rows.length).toBe(478);
    expect(bands.length).toBe(7);
    expect(postcodes['E145AB'].miles).toBe(2.4);
  });

  it('supports Relational + JSONB multi-product CRUD identically in PostgresDataRepository, InMemory, and Sqlite', async () => {
    const pgRepo = await PostgresDataRepository.create({ seedFrom: jsonRepo });
    const memoryRepo = await InMemoryDataRepository.fromRepository(jsonRepo);
    const sqliteRepo = await SqliteDataRepository.createSeeded(jsonRepo, ':memory:');

    try {
      for (const repo of [pgRepo, memoryRepo, sqliteRepo]) {
        // 1. Verify multi-product catalog & JSONB attributes in DB
        const products = await repo.getProducts();
        expect(products.length).toBe(3);

        const booklets = await repo.getProductById('saddle-stitched-booklets');
        expect(booklets?.attributes.length).toBe(5);
        expect(booklets?.vatRate).toBe(0);

        const banners = await repo.getProductById('roller-banners');
        expect(banners?.vatRate).toBe(0.2);
        expect(banners?.attributes.map((a) => a.attributeKey)).toEqual(['size', 'cassette']);

        // 2. Dynamically add a new product ("Business Cards") with JSONB attributes & validation rules
        const newProduct = await repo.upsertProduct({
          id: 'business-cards',
          name: 'Luxury business cards',
          singularName: 'Luxury business card',
          category: 'Stationery',
          vatRate: 0.2,
          active: true,
          defaultPaper: '400gsm Matt Laminated',
          keywords: ['business card', 'business cards'],
          stockRecommendation: null,
          rfcModelConfig: {
            baseExpectedHours: 2.5,
            minExpectedHours: 1.5,
            a4AdderHours: 0,
            p80AnchorHours: 4.5,
            p80BlendWeight: 0.35,
          },
          pricingConfig: {
            standardThresholdHours: 72,
            standardDeliveryAllowance: 12,
            protectedCostFloorMultiplier: 2,
            quoteRoundingStep: 5,
            compressionRoundingStep: 25,
            deadlineCompressionPoints: [
              [0, 400],
              [12, 50],
              [23, 0],
            ],
          },
          attributes: [
            {
              productId: 'business-cards',
              attributeKey: 'corners',
              label: 'Corner style',
              inputType: 'select',
              sortOrder: 1,
              required: true,
              questionPrompt: 'Square or rounded corners?',
              validationRules: { allowedValues: ['Square', 'Rounded'] },
              quickChoices: [
                { label: 'Square', value: 'Square' },
                { label: 'Rounded', value: 'Rounded' },
              ],
            },
          ],
        });
        expect(newProduct.id).toBe('business-cards');
        expect((await repo.getProducts()).length).toBe(4);

        // 3. Update business config dynamically
        const updatedCfg = await repo.updateBusinessConfig({
          pricingRules: {
            ...(await repo.getBusinessConfig()).pricingRules,
            standardDeliveryAllowance: 25,
          },
        });
        expect(updatedCfg.pricingRules.standardDeliveryAllowance).toBe(25);

        // 4. Add a postcode distance dynamically
        const updatedPostcodes = await repo.upsertPostcodeDistance('E1 3NL', {
          miles: 1.8,
          source: 'verified dynamic test',
        });
        expect(updatedPostcodes['E13NL']).toEqual({ miles: 1.8, source: 'verified dynamic test' });

        // 5. Add an HRJ historical job with JSONB attributes
        const jobsAfterAdd = await repo.addHrjHistoricalJob({
          order_id: '99999',
          product_id: 'flyers-leaflets',
          vendor_due: 120,
          qty: 500,
          size2: 'A5',
          pages: 8,
          attributes: { sides: 'Double-sided', stock: '170gsm Silk' },
          hours_to_deadline: 18,
          paid_at: '2026-10-01 12:00:00',
          source: 'BO2',
          urgency_reliable: true,
        });
        expect(jobsAfterAdd.length).toBe(38);

        const flyerJobs = await repo.getHrjHistoricalJobs('flyers-leaflets');
        expect(flyerJobs.length).toBe(1);
        expect(flyerJobs[0].attributes?.sides).toBe('Double-sided');

        expect(await repo.getProductById('does-not-exist')).toBeNull();
        expect((await repo.getSupplierCapabilities('flyers-leaflets')).length).toBeGreaterThan(0);

        const dnpAfter = await repo.addDnpSellingObservation({
          id: 'dnp-test-1',
          product_id: 'flyers-leaflets',
          source: 'BO2',
          qty: 250,
          size2: 'A5',
          pages: 8,
          sell: 220,
          vendor_due: 90,
          paid_at: '2026-10-01 12:00:00',
          hours_to_deadline: 18,
          urgency_reliable: true,
        });
        expect(dnpAfter.some((o) => o.id === 'dnp-test-1')).toBe(true);
        expect((await repo.getDnpSellingObservations('flyers-leaflets')).length).toBeGreaterThan(0);

        await repo.saveHrjHistoricalJobs(await repo.getHrjHistoricalJobs());
        await repo.saveDnpSellingObservations(await repo.getDnpSellingObservations());
        await repo.saveRoute1StandardPrices(await repo.getRoute1StandardPrices());
        await repo.saveCourierDistanceBands(await repo.getCourierDistanceBands());

        const matrix = await repo.getStandardPriceMatrix('saddle-stitched-booklets');
        expect(matrix.length).toBeGreaterThan(0);
        await repo.saveStandardPriceMatrix('saddle-stitched-booklets', matrix.slice(0, 3));
        expect((await repo.getStandardPriceMatrix('saddle-stitched-booklets')).length).toBe(3);
        await repo.saveStandardPriceMatrix('no-such-product', []);
        await repo.saveStandardPriceMatrix('saddle-stitched-booklets', matrix);

        const cap = (await repo.getSupplierCapabilities('saddle-stitched-booklets'))[0];
        const updatedCap = await repo.upsertSupplierCapability({ ...cap, supported: true });
        expect(updatedCap.supported).toBe(true);

        const renamed = await repo.upsertProduct({ ...booklets!, name: booklets!.name });
        expect(renamed.id).toBe('saddle-stitched-booklets');
      }
    } finally {
      await pgRepo.close();
    }
  });

  it('persists JsonCsv writes against a temporary data directory without touching production seeds', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'printpilot-jsoncsv-'));
    const src = path.resolve(process.cwd(), 'data');
    for (const name of await fs.readdir(src)) {
      await fs.copyFile(path.join(src, name), path.join(tmp, name));
    }

    const repo = new JsonCsvDataRepository(tmp);
    const products = await repo.getProducts();
    const updated = await repo.upsertProduct({ ...products[0], defaultPaper: 'Temp Silk' });
    expect(updated.defaultPaper).toBe('Temp Silk');
    expect((await repo.getProducts())[0].defaultPaper).toBe('Temp Silk');

    const added = await repo.upsertProduct({
      ...products[0],
      id: 'temp-product',
      name: 'Temp product',
      singularName: 'Temp product',
    });
    expect(added.id).toBe('temp-product');

    const caps = await repo.getSupplierCapabilities();
    await repo.upsertSupplierCapability({ ...caps[0], supported: true });
    const newCap = await repo.upsertSupplierCapability({
      ...caps[0],
      productId: 'temp-product',
    });
    expect(newCap.productId).toBe('temp-product');

    const cfg = await repo.updateBusinessConfig({ productName: 'Temp booklets' });
    expect(cfg.productName).toBe('Temp booklets');

    const jobs = await repo.addHrjHistoricalJob({
      ...(await repo.getHrjHistoricalJobs())[0],
      order_id: 'TEMP-HRJ',
    });
    expect(jobs.some((j) => j.order_id === 'TEMP-HRJ')).toBe(true);
    expect((await repo.getHrjHistoricalJobs('saddle-stitched-booklets')).length).toBeGreaterThan(0);

    const dnp = await repo.addDnpSellingObservation({
      ...(await repo.getDnpSellingObservations())[0],
      id: 'TEMP-DNP',
    });
    expect(dnp.some((o) => o.id === 'TEMP-DNP')).toBe(true);
    expect((await repo.getDnpSellingObservations('saddle-stitched-booklets')).length).toBeGreaterThan(0);

    const matrix = await repo.getStandardPriceMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    await repo.saveStandardPriceMatrix('saddle-stitched-booklets', matrix.slice(0, 2));
    expect((await repo.getRoute1StandardPrices('saddle-stitched-booklets')).length).toBe(2);

    const bands = await repo.getCourierDistanceBands();
    await repo.saveCourierDistanceBands(bands);
    const pc = await repo.upsertPostcodeDistance('EC1A 1BB', { miles: 1.1, source: 'temp' });
    expect(pc['EC1A1BB'].miles).toBe(1.1);

    await fs.writeFile(
      path.join(tmp, 'route1_booklet_prices.csv'),
      'size,quantity,pages,price\nA4,25,8,40\n,,, \nA5,50,16,55\n',
      'utf8'
    );
    const parsed = await repo.getRoute1StandardPrices();
    expect(parsed.some((r) => r.size === 'A4' && r.quantity === 25)).toBe(true);
  });
});
