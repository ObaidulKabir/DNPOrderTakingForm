import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';
import { FixedClock } from '../../src/domain/clock.js';
import { JsonCsvDataRepository } from '../../src/repositories/JsonCsvDataRepository.js';
import { PostgresDataRepository } from '../../src/repositories/PostgresDataRepository.js';

describe('PrintPilot REST API & Multi-Product PostgreSQL Integration', () => {
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

  it('GET /api/bootstrap returns multi-product catalog, active product, and initial specification', async () => {
    const res = await request(app).get('/api/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeGreaterThanOrEqual(3);
    expect(res.body.activeProduct.id).toBe('saddle-stitched-booklets');
    expect(res.body.initialSpec.product).toBe('Saddle-stitched booklets');
    expect(res.body.evaluation.progress.done).toBe(1);
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
    // Flyers do not ask orientation or pages; they ask 'sides' next!
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
    // Since deadline and quantity were already extracted, next step is artwork!
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

  it('supports Admin Dashboard summary and data feed endpoints (HRJ jobs, DNP selling, Route1 tariff)', async () => {
    const summaryRes = await request(app).get('/api/admin/summary');
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.counts.products).toBeGreaterThanOrEqual(3);
    expect(summaryRes.body.counts.hrjHistoricalJobs).toBe(37);

    // Feed a new HRJ job via Admin endpoint
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
      r1Res.body.some((r: { size: string; quantity: number; pages: number; price: number }) => r.size === 'A4' && r.quantity === 150 && r.pages === 20 && r.price === 199.5)
    ).toBe(true);
  });
});
