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
      }
    } finally {
      await pgRepo.close();
    }
  });
});
