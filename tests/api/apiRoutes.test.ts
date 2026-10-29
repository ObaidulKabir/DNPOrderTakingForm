import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';
import { FixedClock } from '../../src/domain/clock.js';
import { JsonCsvDataRepository } from '../../src/repositories/JsonCsvDataRepository.js';
import { PostgresDataRepository } from '../../src/repositories/PostgresDataRepository.js';

describe('PrintPilot REST API, Validation, Admin Feeds & Error Paths', () => {
  let pgRepo: PostgresDataRepository;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const fileRepo = new JsonCsvDataRepository();
    pgRepo = await PostgresDataRepository.create({ seedFrom: fileRepo });
    const clock = new FixedClock(new Date(2026, 9, 29, 14, 0, 0));
    const container = createContainer(pgRepo, clock);
    app = createApp(container);
  });

  afterAll(async () => {
    if (pgRepo) {
      await pgRepo.close();
    }
  });

  it('GET /api/bootstrap returns 400-free catalog, active product, and initial specification', async () => {
    const res = await request(app).get('/api/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeGreaterThanOrEqual(3);
    expect(res.body.activeProduct.id).toBe('saddle-stitched-booklets');
    expect(res.body.initialSpec.product).toBe('Saddle-stitched booklets');
    expect(res.body.evaluation.progress.done).toBe(1);

    const resFlyers = await request(app).get('/api/bootstrap?productId=flyers-leaflets');
    expect(resFlyers.status).toBe(200);
    expect(resFlyers.body.activeProduct.id).toBe('flyers-leaflets');
  });

  it('rejects conversation and evaluation endpoints with 400 on missing required fields', async () => {
    expect((await request(app).post('/api/conversation/start').send({})).status).toBe(400);
    expect((await request(app).post('/api/conversation/choice').send({})).status).toBe(400);
    expect((await request(app).post('/api/conversation/reply').send({ spec: {} })).status).toBe(400);
    expect((await request(app).post('/api/conversation/upload').send({})).status).toBe(400);
    expect((await request(app).post('/api/quote/evaluate').send({})).status).toBe(400);
  });

  it('POST /api/conversation/start auto-quotes default booklet prompt', async () => {
    const prompt =
      '100 copies, A4 portrait, 20 pages, 350gsm cover, 170gsm inner, 39 Solent House, E1 3NL, 3.4 miles and Artwork Ready. Needed by tomorrow 10 am';

    const res = await request(app).post('/api/conversation/start').send({ prompt });
    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe('done');
    expect(res.body.spec.productId).toBe('saddle-stitched-booklets');
    expect(res.body.evaluation.quoteState.mode).toBe('quote');
    expect(res.body.evaluation.quoteState.total).toBeGreaterThan(0);
    expect(res.body.evaluation.quoteState.vatAmount).toBe(0);
    expect(res.body.botMessages.length).toBe(2);
  });

  it('automatically detects Flyers/Leaflets from prompt and asks flyer-specific dynamic attributes (sides & stock)', async () => {
    const startRes = await request(app)
      .post('/api/conversation/start')
      .send({ prompt: 'I need 250 A5 flyers delivered tomorrow by 3pm' });

    expect(startRes.status).toBe(200);
    expect(startRes.body.spec.productId).toBe('flyers-leaflets');
    expect(startRes.body.spec.size).toBe('A5');
    expect(startRes.body.spec.quantity).toBe(250);
    expect(startRes.body.currentStep).toBe('sides');

    const sidesRes = await request(app).post('/api/conversation/choice').send({
      spec: startRes.body.spec,
      currentStep: 'sides',
      value: 'Double-sided',
    });
    expect(sidesRes.status).toBe(200);
    expect(sidesRes.body.spec.attributes.sides).toBe('Double-sided');
    expect(sidesRes.body.currentStep).toBe('stock');

    const stockRes = await request(app).post('/api/conversation/choice').send({
      spec: sidesRes.body.spec,
      currentStep: 'stock',
      value: '170gsm Silk',
    });
    expect(stockRes.status).toBe(200);
    expect(stockRes.body.spec.attributes.stock).toBe('170gsm Silk');
    expect(stockRes.body.currentStep).toBe('artwork');
  });

  it('detects Roller Banners, applies 20% VAT, and quotes via PostgreSQL multi-product engine', async () => {
    const startRes = await request(app).post('/api/conversation/start').send({
      prompt:
        '4 roller banners, 850mm, Standard Base, artwork ready, 39 Solent House, E1 3NL, 3.4 miles, tomorrow by 4pm',
    });

    expect(startRes.status).toBe(200);
    expect(startRes.body.spec.productId).toBe('roller-banners');
    expect(startRes.body.currentStep).toBe('done');
    expect(startRes.body.evaluation.quoteState.mode).toBe('quote');
    expect(startRes.body.evaluation.quoteState.vatRate).toBe(0.2);
    expect(startRes.body.evaluation.quoteState.vatAmount).toBeGreaterThan(0);
    expect(startRes.body.evaluation.quoteState.priceSubtext).toContain('20% VAT');
  });

  it('dynamically updates postcode distance and business config in PostgreSQL and reflects changes in quote evaluation', async () => {
    const pcRes = await request(app)
      .post('/api/data/postcodes')
      .send({ postcode: 'E1 3NL', miles: 2.2, source: 'PostgreSQL Dynamic Route Service' });
    expect(pcRes.status).toBe(201);
    expect(pcRes.body['E13NL'].miles).toBe(2.2);

    const spec = {
      productId: 'saddle-stitched-booklets',
      product: 'Saddle-stitched booklets',
      quantity: 50,
      size: 'A5',
      pages: 16,
      cover: '350gsm Silk',
      inner: '170gsm Silk',
      paper: 'Silk / Matt',
      orientation: 'Portrait',
      artwork: 'Ready',
      file: null,
      postcode: 'E1 3NL',
      address: '39 Solent House',
      hotel: false,
      hotelName: null,
      deadline: new Date(2026, 9, 30, 15, 0, 0).toISOString(),
      devMiles: null,
    };

    const evalRes1 = await request(app).post('/api/quote/evaluate').send({ spec, triggerQuote: true });
    expect(evalRes1.status).toBe(200);
    expect(evalRes1.body.quoteState.mode).toBe('quote');
    expect(evalRes1.body.diagnosticsHtml).toContain('2.2 miles');
    expect(evalRes1.body.diagnosticsHtml).toContain('PostgreSQL Dynamic Route Service');
  });

  it('supports Admin Dashboard summary and data feed endpoints (HRJ, DNP, Route1, Products, Capabilities, Distance Bands, Config)', async () => {
    const summaryRes = await request(app).get('/api/admin/summary');
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.counts.products).toBeGreaterThanOrEqual(3);
    expect(summaryRes.body.counts.hrjHistoricalJobs).toBe(37);

    // Feed a new HRJ job
    const addHrjRes = await request(app).post('/api/data/hrj-jobs').send({
      order_id: 'ADM-101',
      product_id: 'saddle-stitched-booklets',
      vendor_due: 180,
      qty: 50,
      size2: 'A4',
      pages: 24,
      hours_to_deadline: 14,
      paid_at: '2026-10-28 11:00:00',
      source: 'BO2',
      urgency_reliable: true,
    });
    expect(addHrjRes.status).toBe(201);
    expect(addHrjRes.body.some((x: { order_id: string }) => x.order_id === 'ADM-101')).toBe(true);

    // Delete the test HRJ job
    const delHrjRes = await request(app).delete('/api/data/hrj-jobs/ADM-101');
    expect(delHrjRes.status).toBe(200);
    expect(delHrjRes.body.some((x: { order_id: string }) => x.order_id === 'ADM-101')).toBe(false);

    // Feed DNP selling observation and then delete it
    const addDnpRes = await request(app).post('/api/data/dnp-selling').send({
      id: 'ADM-DNP-1',
      product_id: 'saddle-stitched-booklets',
      source: 'BO2',
      qty: 50,
      size2: 'A4',
      pages: 20,
      sell: 550,
      vendor_due: 180,
      paid_at: '2026-10-28 11:00:00',
      hours_to_deadline: 14,
      urgency_reliable: true,
    });
    expect(addDnpRes.status).toBe(201);
    const delDnpRes = await request(app).delete('/api/data/dnp-selling/ADM-DNP-1');
    expect(delDnpRes.status).toBe(200);

    // Upsert a single Route1 standard tariff row
    const r1Res = await request(app).post('/api/data/route1-prices').send({
      productId: 'saddle-stitched-booklets',
      size: 'A4',
      quantity: 150,
      pages: 20,
      price: 199.5,
    });
    expect(r1Res.status).toBe(201);
    expect(
      r1Res.body.some(
        (r: { size: string; quantity: number; pages: number; price: number }) =>
          r.size === 'A4' && r.quantity === 150 && r.pages === 20 && r.price === 199.5
      )
    ).toBe(true);

    // Missing required Route1 fields
    expect((await request(app).post('/api/data/route1-prices').send({ size: 'A4' })).status).toBe(400);

    // PUT products, capabilities, distance-bands, business-config, hrj-jobs, dnp-selling, route1-prices
    const origProduct = (await request(app).get('/api/data/products/flyers-leaflets')).body;
    const putProd = await request(app)
      .put('/api/data/products/flyers-leaflets')
      .send({ ...origProduct, defaultPaper: '170gsm Silk Test' });
    expect(putProd.status).toBe(200);
    expect(putProd.body.defaultPaper).toBe('170gsm Silk Test');

    const capRes = await request(app).post('/api/data/supplier-capabilities').send({
      supplierId: 'hrj-media',
      supplierName: 'HRJ Media',
      productId: 'flyers-leaflets',
      supported: true,
      excludedCombinations: [],
      quantityLimitsByHours: [
        { maxHours: 12, maxQty: 1000, choices: [50, 100, 250, 500, 1000] },
      ],
      defaultQuantityChoices: [100, 250, 500],
    });
    expect(capRes.status).toBe(201);

    const origBands = (await request(app).get('/api/data/distance-bands')).body;
    const putBands = await request(app).put('/api/data/distance-bands').send(origBands);
    expect(putBands.status).toBe(200);
    expect(putBands.body.length).toBe(origBands.length);

    const origConfig = (await request(app).get('/api/data/business-config')).body;
    const putConfig = await request(app)
      .put('/api/data/business-config')
      .send({ ...origConfig, hrjRouting: { ...origConfig.hrjRouting, minHoursDirect: 5 } });
    expect(putConfig.status).toBe(200);
    expect(putConfig.body.hrjRouting.minHoursDirect).toBe(5);

    // 400s for PUT array endpoints
    expect((await request(app).put('/api/data/hrj-jobs').send({ not: 'an array' })).status).toBe(400);
    expect((await request(app).put('/api/data/dnp-selling').send({ not: 'an array' })).status).toBe(400);
    expect((await request(app).put('/api/data/route1-prices').send({ not: 'an array' })).status).toBe(400);
    expect((await request(app).put('/api/data/distance-bands').send({ not: 'an array' })).status).toBe(400);
    expect((await request(app).post('/api/data/products').send({ name: 'no-id' })).status).toBe(400);
    expect((await request(app).post('/api/data/supplier-capabilities').send({})).status).toBe(400);
    expect((await request(app).post('/api/data/postcodes').send({})).status).toBe(400);
    expect((await request(app).get('/api/data/products/does-not-exist')).status).toBe(404);

    const [hrjGet, dnpGet, r1Get, pcGet, cfgGet, prodGet, capGet] = await Promise.all([
      request(app).get('/api/data/hrj-jobs?productId=saddle-stitched-booklets'),
      request(app).get('/api/data/dnp-selling?productId=saddle-stitched-booklets'),
      request(app).get('/api/data/route1-prices?productId=saddle-stitched-booklets'),
      request(app).get('/api/data/postcodes'),
      request(app).get('/api/data/business-config'),
      request(app).get('/api/data/products'),
      request(app).get('/api/data/supplier-capabilities?productId=flyers-leaflets'),
    ]);
    expect(hrjGet.status).toBe(200);
    expect(dnpGet.status).toBe(200);
    expect(r1Get.status).toBe(200);
    expect(pcGet.status).toBe(200);
    expect(cfgGet.status).toBe(200);
    expect(prodGet.status).toBe(200);
    expect(capGet.status).toBe(200);

    const hrjAll = (await request(app).get('/api/data/hrj-jobs')).body;
    const putHrj = await request(app).put('/api/data/hrj-jobs').send(hrjAll);
    expect(putHrj.status).toBe(200);

    const dnpAll = (await request(app).get('/api/data/dnp-selling')).body;
    expect((await request(app).put('/api/data/dnp-selling').send(dnpAll)).status).toBe(200);

    const r1All = (await request(app).get('/api/data/route1-prices')).body;
    expect((await request(app).put('/api/data/route1-prices').send(r1All)).status).toBe(200);

    const created = await request(app).post('/api/data/products').send({
      id: 'api-temp-cards',
      name: 'API temp cards',
      singularName: 'API temp card',
      category: 'Stationery',
      vatRate: 0.2,
      active: true,
      defaultPaper: '400gsm',
      keywords: ['api card'],
      stockRecommendation: null,
      rfcModelConfig: {
        baseExpectedHours: 2,
        minExpectedHours: 1,
        a4AdderHours: 0,
        p80AnchorHours: 4,
        p80BlendWeight: 0.3,
      },
      pricingConfig: {
        standardThresholdHours: 72,
        standardDeliveryAllowance: 12,
        protectedCostFloorMultiplier: 2,
        quoteRoundingStep: 5,
        compressionRoundingStep: 25,
        deadlineCompressionPoints: [
          [0, 400],
          [23, 0],
        ],
      },
      attributes: [],
    });
    expect(created.status).toBe(201);

    const conv = await request(app).post('/api/conversation/start').send({ prompt: 'I need some booklets printed' });
    expect(conv.status).toBe(200);
    const replied = await request(app).post('/api/conversation/reply').send({
      spec: conv.body.spec,
      currentStep: conv.body.currentStep,
      text: 'A4',
    });
    expect(replied.status).toBe(200);
    expect(replied.body.spec.size).toBe('A4');

    const uploaded = await request(app).post('/api/conversation/upload').send({
      spec: replied.body.spec,
      fileName: 'api-art.pdf',
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.spec.file).toBe('api-art.pdf');
  });
});

describe('API error mapping when the repository throws', () => {
  it('returns 500 from bootstrap, admin, conversation, quote, and data endpoints', async () => {
    const throwingRepo = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return undefined;
          return async () => {
            throw new Error('forced repository failure');
          };
        },
      }
    );
    const app = createApp(
      createContainer(throwingRepo as never, new FixedClock(new Date(2026, 9, 29, 14, 0, 0)))
    );

    const paths: Array<[string, string, object?]> = [
      ['get', '/api/bootstrap'],
      ['get', '/api/admin/summary'],
      ['post', '/api/conversation/start', { prompt: 'hello' }],
      ['post', '/api/conversation/choice', { spec: { productId: 'x' }, currentStep: 'size', value: 'A4' }],
      ['post', '/api/conversation/reply', { spec: { productId: 'x' }, currentStep: 'size', text: 'A4' }],
      ['post', '/api/conversation/upload', { spec: { productId: 'x' }, fileName: 'a.pdf' }],
      ['post', '/api/quote/evaluate', { spec: { productId: 'x' } }],
      ['get', '/api/data/products'],
      ['get', '/api/data/products/saddle-stitched-booklets'],
      ['post', '/api/data/products', { id: 'x', name: 'X' }],
      ['put', '/api/data/products/x', { id: 'x', name: 'X' }],
      ['get', '/api/data/supplier-capabilities'],
      ['post', '/api/data/supplier-capabilities', { supplierId: 'hrj-media', productId: 'x' }],
      ['get', '/api/data/business-config'],
      ['put', '/api/data/business-config', {}],
      ['get', '/api/data/hrj-jobs'],
      ['post', '/api/data/hrj-jobs', { order_id: 'x' }],
      ['delete', '/api/data/hrj-jobs/x'],
      ['put', '/api/data/hrj-jobs', []],
      ['get', '/api/data/dnp-selling'],
      ['post', '/api/data/dnp-selling', { id: 'x' }],
      ['delete', '/api/data/dnp-selling/x'],
      ['put', '/api/data/dnp-selling', []],
      ['get', '/api/data/route1-prices'],
      ['post', '/api/data/route1-prices', { size: 'A4', quantity: 25, price: 10 }],
      ['put', '/api/data/route1-prices', []],
      ['get', '/api/data/distance-bands'],
      ['put', '/api/data/distance-bands', []],
      ['get', '/api/data/postcodes'],
      ['post', '/api/data/postcodes', { postcode: 'E1 3NL', miles: 1 }],
    ];

    for (const [method, url, body] of paths) {
      const req = request(app)[method as 'get' | 'post' | 'put' | 'delete'](url);
      const res = body ? await req.send(body) : await req;
      expect(res.status, `${method.toUpperCase()} ${url}`).toBe(500);
      expect(res.body.error).toContain('forced repository failure');
    }
  });
});

describe('createApp default container', () => {
  it('bootstraps against the JsonCsv seed data when no container is injected', async () => {
    const app = createApp();
    const res = await request(app).get('/api/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeGreaterThanOrEqual(3);
  });
});
