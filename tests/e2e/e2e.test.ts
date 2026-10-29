import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';
import { FixedClock } from '../../src/domain/clock.js';
import { JsonCsvDataRepository } from '../../src/repositories/JsonCsvDataRepository.js';
import { PostgresDataRepository } from '../../src/repositories/PostgresDataRepository.js';

function htmlIds(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bid=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    ids.add(match[1]);
  }
  return ids;
}

describe('E2E: Storefront Conversational Flow + Admin Dashboard Data Feed (Live HTTP Server)', () => {
  let pgRepo: PostgresDataRepository;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const fileRepo = new JsonCsvDataRepository();
    pgRepo = await PostgresDataRepository.create({ seedFrom: fileRepo });
    const clock = new FixedClock(new Date(2026, 9, 29, 14, 0, 0));
    const container = createContainer(pgRepo, clock);
    const app = createApp(container);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await pgRepo.close();
  });

  it('serves Storefront and Admin static assets with expected UI chrome and API contracts', async () => {
    const storefrontRes = await fetch(`${baseUrl}/`);
    expect(storefrontRes.status).toBe(200);
    const storefrontHtml = await storefrontRes.text();
    expect(storefrontHtml).toContain('PrintPilot');
    expect(storefrontHtml).toContain('id="initialPrompt"');
    expect(storefrontHtml).toContain('id="startBtn"');
    expect(storefrontHtml).toContain('href="/admin.html"');
    expect(storefrontHtml).toContain('src="/app.js"');
    expect(storefrontHtml).toContain('href="/styles.css"');

    const storefrontIds = htmlIds(storefrontHtml);
    for (const id of ['initialPrompt', 'startBtn', 'messages', 'file']) {
      expect(storefrontIds.has(id)).toBe(true);
    }

    const [appJsRes, stylesRes] = await Promise.all([
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/styles.css`),
    ]);
    expect(appJsRes.status).toBe(200);
    expect(stylesRes.status).toBe(200);
    const appJs = await appJsRes.text();
    expect(appJs).toContain('/api/bootstrap');
    expect(appJs).toContain('/api/conversation/start');
    expect(appJs).toContain('/api/conversation/choice');
    expect(appJs).toContain('/api/conversation/reply');
    expect(appJs).toContain('/api/conversation/upload');
    expect(appJs).toContain('/api/quote/evaluate');

    const adminRes = await fetch(`${baseUrl}/admin.html`);
    expect(adminRes.status).toBe(200);
    const adminHtml = await adminRes.text();
    expect(adminHtml).toContain('PrintPilot Admin');
    expect(adminHtml).toContain('data-tab="overview"');
    expect(adminHtml).toContain('data-tab="products"');
    expect(adminHtml).toContain('data-tab="hrj"');
    expect(adminHtml).toContain('data-tab="manual"');
    expect(adminHtml).toContain('src="/admin.js"');
    expect(adminHtml).toContain('href="/admin.css"');

    const adminIds = htmlIds(adminHtml);
    for (const id of [
      'tab-overview',
      'tab-products',
      'tab-capabilities',
      'tab-hrj',
      'tab-dnp',
      'tab-route1',
      'tab-logistics',
      'tab-config',
      'tab-manual',
      'kpiProducts',
      'kpiHrj',
      'kpiDnp',
      'kpiRoute1',
      'hrjOrderId',
      'dnpSell',
      'pcCode',
      'prodId',
    ]) {
      expect(adminIds.has(id)).toBe(true);
    }

    const [adminJsRes, adminCssRes] = await Promise.all([
      fetch(`${baseUrl}/admin.js`),
      fetch(`${baseUrl}/admin.css`),
    ]);
    expect(adminJsRes.status).toBe(200);
    expect(adminCssRes.status).toBe(200);
    const adminJs = await adminJsRes.text();
    expect(adminJs).toContain('async function loadAllAdminData');
    expect(adminJs).toContain('async function saveProductForm');
    expect(adminJs).toContain('async function addHrjJob');
    expect(adminJs).toContain('async function addDnpObservation');
    expect(adminJs).toContain('async function addPostcodeDistance');
    expect(adminJs).toContain('async function saveBusinessConfig');
    expect(adminJs).toContain('function switchTab');
    expect(adminJs).toContain('/api/admin/summary');
    expect(adminJs).toContain('/api/data/hrj-jobs');
    expect(adminJs).toContain('/api/data/dnp-selling');
    expect(adminJs).toContain('/api/data/postcodes');
  });

  it('executes the full Storefront conversational flow via fetch (complete booklet prompt → quote → sidebar edit)', async () => {
    const prompt =
      '100 copies, A4 portrait, 20 pages, 350gsm cover, 170gsm inner, 39 Solent House, E1 3NL, 3.4 miles and Artwork Ready. Needed by tomorrow 10 am';

    const convRes = await fetch(`${baseUrl}/api/conversation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    expect(convRes.status).toBe(200);
    const conv = await convRes.json();
    expect(conv.currentStep).toBe('done');
    expect(conv.evaluation.quoteState.mode).toBe('quote');
    expect(conv.evaluation.quoteState.total).toBeGreaterThan(0);
    expect(conv.evaluation.progress.percent).toBeGreaterThan(80);

    const editedSpec = { ...conv.spec, quantity: 50 };
    const evalRes = await fetch(`${baseUrl}/api/quote/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: editedSpec, triggerQuote: true }),
    });
    expect(evalRes.status).toBe(200);
    const evaluation = await evalRes.json();
    expect(evaluation.quoteState.mode).toBe('quote');
    expect(evaluation.spec.quantity).toBe(50);

    const uploadRes = await fetch(`${baseUrl}/api/conversation/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: conv.spec, fileName: 'e2e-artwork.pdf' }),
    });
    expect(uploadRes.status).toBe(200);
    const uploaded = await uploadRes.json();
    expect(uploaded.spec.file).toBe('e2e-artwork.pdf');
  });

  it('walks a multi-turn Storefront flyer conversation through choice and reply endpoints', async () => {
    const startRes = await fetch(`${baseUrl}/api/conversation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'I need 250 A5 flyers delivered tomorrow by 3pm' }),
    });
    expect(startRes.status).toBe(200);
    const start = await startRes.json();
    expect(start.spec.productId).toBe('flyers-leaflets');
    expect(start.currentStep).toBe('sides');

    const sidesRes = await fetch(`${baseUrl}/api/conversation/choice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: start.spec, currentStep: 'sides', value: 'Double-sided' }),
    });
    const sides = await sidesRes.json();
    expect(sides.spec.attributes.sides).toBe('Double-sided');

    const stockRes = await fetch(`${baseUrl}/api/conversation/choice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: sides.spec, currentStep: sides.currentStep, value: '170gsm Silk' }),
    });
    const stock = await stockRes.json();
    expect(stock.currentStep).toBe('artwork');

    const artRes = await fetch(`${baseUrl}/api/conversation/choice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: stock.spec, currentStep: 'artwork', value: 'ready' }),
    });
    const art = await artRes.json();
    expect(art.spec.artwork).toBe('Ready');

    const pcRes = await fetch(`${baseUrl}/api/conversation/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: art.spec, currentStep: art.currentStep, text: 'E1 3NL' }),
    });
    expect(pcRes.status).toBe(200);
    const pc = await pcRes.json();
    expect(pc.spec.postcode).toBeTruthy();
  });

  it('quotes roller banners with VAT through the live Storefront API', async () => {
    const startRes = await fetch(`${baseUrl}/api/conversation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt:
          '4 roller banners, 850mm, Standard Base, artwork ready, 39 Solent House, E1 3NL, 3.4 miles, tomorrow by 4pm',
      }),
    });
    expect(startRes.status).toBe(200);
    const start = await startRes.json();
    expect(start.spec.productId).toBe('roller-banners');
    expect(start.currentStep).toBe('done');
    expect(start.evaluation.quoteState.mode).toBe('quote');
    expect(start.evaluation.quoteState.vatRate).toBe(0.2);
    expect(start.evaluation.quoteState.vatAmount).toBeGreaterThan(0);
  });

  it('executes the Admin Dashboard data-feed loop and verifies records on GET endpoints', async () => {
    const hrjRes = await fetch(`${baseUrl}/api/data/hrj-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: 'E2E-HRJ-1',
        product_id: 'saddle-stitched-booklets',
        vendor_due: 175,
        qty: 40,
        size2: 'A5',
        pages: 16,
        hours_to_deadline: 18,
        paid_at: '2026-10-28 09:00:00',
        source: 'BO2',
        urgency_reliable: true,
      }),
    });
    expect(hrjRes.status).toBe(201);
    const hrjJobs = await hrjRes.json();
    expect(hrjJobs.some((j: { order_id: string }) => j.order_id === 'E2E-HRJ-1')).toBe(true);

    const dnpRes = await fetch(`${baseUrl}/api/data/dnp-selling`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'E2E-DNP-1',
        product_id: 'saddle-stitched-booklets',
        source: 'BO2',
        qty: 40,
        size2: 'A5',
        pages: 16,
        sell: 480,
        vendor_due: 175,
        paid_at: '2026-10-28 09:00:00',
        hours_to_deadline: 18,
        urgency_reliable: true,
      }),
    });
    expect(dnpRes.status).toBe(201);

    const pcRes = await fetch(`${baseUrl}/api/data/postcodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postcode: 'SW1A 1AA',
        miles: 5.8,
        source: 'E2E Verified Admin Route',
      }),
    });
    expect(pcRes.status).toBe(201);
    const pcMap = await pcRes.json();
    expect(pcMap['SW1A1AA'].miles).toBe(5.8);

    const productRes = await fetch(`${baseUrl}/api/data/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'e2e-cards',
        name: 'E2E cards',
        singularName: 'E2E card',
        category: 'Stationery',
        vatRate: 0.2,
        active: true,
        defaultPaper: '400gsm',
        keywords: ['e2e card'],
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
      }),
    });
    expect(productRes.status).toBe(201);

    const [summaryRes, productsGet, hrjGet, dnpGet, r1Get, bandsGet, pcGet, cfgGet, capsGet, bootRes] =
      await Promise.all([
        fetch(`${baseUrl}/api/admin/summary`),
        fetch(`${baseUrl}/api/data/products`),
        fetch(`${baseUrl}/api/data/hrj-jobs?productId=saddle-stitched-booklets`),
        fetch(`${baseUrl}/api/data/dnp-selling?productId=saddle-stitched-booklets`),
        fetch(`${baseUrl}/api/data/route1-prices?productId=saddle-stitched-booklets`),
        fetch(`${baseUrl}/api/data/distance-bands`),
        fetch(`${baseUrl}/api/data/postcodes`),
        fetch(`${baseUrl}/api/data/business-config`),
        fetch(`${baseUrl}/api/data/supplier-capabilities?productId=flyers-leaflets`),
        fetch(`${baseUrl}/api/bootstrap`),
      ]);

    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json();
    expect(summary.counts.hrjHistoricalJobs).toBeGreaterThanOrEqual(38);
    expect(summary.counts.dnpSellingObservations).toBeGreaterThanOrEqual(38);
    expect(summary.counts.verifiedPostcodes).toBeGreaterThanOrEqual(3);
    expect(summary.counts.products).toBeGreaterThanOrEqual(4);

    expect(productsGet.status).toBe(200);
    expect(hrjGet.status).toBe(200);
    expect(dnpGet.status).toBe(200);
    expect(r1Get.status).toBe(200);
    expect(bandsGet.status).toBe(200);
    expect(pcGet.status).toBe(200);
    expect(cfgGet.status).toBe(200);
    expect(capsGet.status).toBe(200);
    expect(bootRes.status).toBe(200);
    const boot = await bootRes.json();
    expect(boot.products.length).toBeGreaterThanOrEqual(3);
  });
});
