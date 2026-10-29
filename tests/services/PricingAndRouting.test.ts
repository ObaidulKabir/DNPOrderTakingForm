import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/domain/clock.js';
import { InMemoryDataRepository } from '../../src/repositories/InMemoryDataRepository.js';
import { JsonCsvDataRepository } from '../../src/repositories/JsonCsvDataRepository.js';
import { createContainer, ServiceContainer } from '../../src/container.js';

describe('Pricing, Routing, RFC, Courier, Resilience & Evaluation Services', () => {
  let container: ServiceContainer;
  let clock: FixedClock;

  beforeEach(async () => {
    const fileRepo = new JsonCsvDataRepository();
    const memoryRepo = await InMemoryDataRepository.fromRepository(fileRepo);
    // Thursday 14:00 local time
    clock = new FixedClock(new Date(2026, 9, 29, 14, 0, 0));
    container = createContainer(memoryRepo, clock);
  });

  it('evaluates PrintedEasy eligibility across weekday cutoff, same-evening collection, and weekends', async () => {
    const config = await container.repo.getBusinessConfig();
    const spec = container.nlpService.createInitialSpec(config);

    // 1. Friday 19:00 deadline (after standardDeliveryDay 18:00)
    spec.deadline = new Date(2026, 9, 30, 19, 0, 0).toISOString();
    const peBeforeCutoff = container.routingService.peRoute(spec, config, clock.now());
    expect(peBeforeCutoff.eligible).toBe(true);
    expect(peBeforeCutoff.reason).toContain('PE cutoff and delivery calendar fit deadline');

    // 2. Same-evening own courier collection (deadline tonight 21:00, paid before 15:30)
    spec.deadline = new Date(2026, 9, 29, 21, 0, 0).toISOString();
    const peSameEvening = container.routingService.peRoute(spec, config, clock.now());
    expect(peSameEvening.eligible).toBe(true);
    expect(peSameEvening.route).toContain('own courier collection');

    // 3. Before cutoff, but deadline does not fit either standard or same-evening (e.g. tomorrow 10am)
    spec.deadline = new Date(2026, 9, 30, 10, 0, 0).toISOString();
    const peBadTiming = container.routingService.peRoute(spec, config, clock.now());
    expect(peBadTiming.eligible).toBe(false);
    expect(peBadTiming.reason).toContain('PE delivery timing does not fit deadline');

    // 4. Move clock to 16:05 (after 15:30 payment cutoff)
    clock.setNow(new Date(2026, 9, 29, 16, 5, 0));
    const peAfterCutoff = container.routingService.peRoute(spec, config, clock.now());
    expect(peAfterCutoff.eligible).toBe(false);
    expect(peAfterCutoff.reason).toContain('Customer payment cutoff 15:30 has passed');

    // 5. Weekend ordering (Saturday) and Sunday (day === 0)
    clock.setNow(new Date(2026, 9, 31, 11, 0, 0));
    const peWeekend = container.routingService.peRoute(spec, config, clock.now());
    expect(peWeekend.eligible).toBe(false);
    expect(peWeekend.reason).toContain('weekend staging rule');

    clock.setNow(new Date(2026, 10, 1, 11, 0, 0)); // Sunday 1 Nov
    const peSunday = container.routingService.peRoute(spec, config, clock.now());
    expect(peSunday.eligible).toBe(false);
    expect(peSunday.reason).toContain('weekend staging rule');

    // 6. Friday ordering skips weekend for standard delivery day
    clock.setNow(new Date(2026, 9, 30, 12, 0, 0)); // Friday noon
    spec.deadline = new Date(2026, 10, 2, 19, 0, 0).toISOString(); // Monday 19:00
    const peFriday = container.routingService.peRoute(spec, config, clock.now());
    expect(peFriday.eligible).toBe(true);
  });

  it('evaluates HRJ routing and selectSupplier across all branches', async () => {
    const config = await container.repo.getBusinessConfig();
    const spec = container.nlpService.createInitialSpec(config);

    // hoursLeft with null or invalid deadline
    expect(container.routingService.hoursLeft(spec, clock.now())).toBeNull();
    spec.deadline = 'invalid-date';
    expect(container.routingService.hoursLeft(spec, clock.now())).toBeNull();

    // maxQtyForHours and getQuantityChoicesForHours with null or >120h
    expect(container.routingService.maxQtyForHours(null, config)).toBe(Infinity);
    expect(container.routingService.maxQtyForHours(200, config)).toBe(Infinity);
    expect(container.routingService.getQuantityChoicesForHours(null, config)).toEqual(
      config.defaultQuantityChoices
    );
    expect(container.routingService.getQuantityChoicesForHours(200, config)).toEqual(
      config.defaultQuantityChoices
    );

    // Early tomorrow (<13:00) with <10h vs >=10h
    spec.deadline = new Date(2026, 9, 30, 10, 0, 0).toISOString(); // 20h away
    const hrjEarly = container.routingService.hrjRoute(spec, config, clock.now());
    expect(hrjEarly.eligible).toBe(true);
    expect(hrjEarly.overnight).toBe(true);
    expect(hrjEarly.confidence).toBe('Medium–high');

    // Direct route (tomorrow 15:00)
    spec.deadline = new Date(2026, 9, 30, 15, 0, 0).toISOString();
    const hrjDirect = container.routingService.hrjRoute(spec, config, clock.now());
    expect(hrjDirect.eligible).toBe(true);
    expect(hrjDirect.overnight).toBe(false);

    // selectSupplier: PE eligible, HRJ eligible, neither eligible
    spec.deadline = new Date(2026, 9, 30, 19, 0, 0).toISOString();
    expect(container.routingService.selectSupplier(spec, config, clock.now()).selected?.supplier).toBe(
      'PrintedEasy'
    );

    spec.deadline = new Date(2026, 9, 30, 10, 0, 0).toISOString();
    expect(container.routingService.selectSupplier(spec, config, clock.now()).selected?.supplier).toBe(
      'HRJ Media'
    );

    spec.deadline = new Date(2026, 9, 29, 15, 0, 0).toISOString(); // 1h away -> neither eligible
    expect(container.routingService.selectSupplier(spec, config, clock.now()).selected).toBeNull();

    // Early tomorrow with <8h (below minHoursEarlyTomorrow) and <10h confidence
    spec.deadline = new Date(2026, 9, 30, 4, 0, 0).toISOString();
    clock.setNow(new Date(2026, 9, 29, 23, 30, 0));
    const hrjTightEarly = container.routingService.hrjRoute(spec, config, clock.now());
    expect(hrjTightEarly.overnight).toBe(true);
    expect(hrjTightEarly.eligible).toBe(false);
    expect(hrjTightEarly.confidence).toBe('Medium');

    clock.setNow(new Date(2026, 9, 29, 14, 0, 0));
    spec.size = 'A4';
    spec.orientation = 'Landscape';
    const caps = await container.repo.getSupplierCapabilities('saddle-stitched-booklets');
    expect(container.routingService.checkSupplierExclusions(spec, 24, caps)).toContain('A4 Landscape');
    expect(container.routingService.checkSupplierExclusions(spec, 80, caps)).toBeNull();
    expect(container.routingService.isValidQuantity(spec, config, clock.now(), caps)).toBe(true);
    spec.quantity = 25;
    spec.deadline = new Date(2026, 9, 30, 10, 0, 0).toISOString();
    expect(container.routingService.isValidQuantity(spec, config, clock.now(), caps)).toBe(true);
    spec.quantity = 500;
    expect(container.routingService.isValidQuantity(spec, config, clock.now(), caps)).toBe(false);
    spec.deadline = null;
    expect(container.routingService.isValidQuantity(spec, config, clock.now(), caps)).toBe(true);
  });

  it('covers CourierService distance resolution, bands, travel hours, and selection branches', async () => {
    const config = await container.repo.getBusinessConfig();
    const bands = await container.repo.getCourierDistanceBands();
    const postcodes = await container.repo.getPostcodeDistances();
    const spec = container.nlpService.createInitialSpec(config);

    // 1. Missing postcode & no devMiles
    expect(container.courierService.distanceInfo(spec, postcodes).source).toBe('missing');

    // 2. Postcode in map (E14 5AB)
    spec.postcode = 'e14 5ab';
    const hitDist = container.courierService.distanceInfo(spec, postcodes);
    expect(hitDist.miles).toBe(2.4);

    // 3. Unknown postcode
    spec.postcode = 'SW1A 2AA';
    expect(container.courierService.distanceInfo(spec, postcodes).miles).toBeNull();

    // 4. Fallback operational buffer calculation when band has no operationalBufferHours
    const strippedBands = bands.map((b) => ({
      ...b,
      operationalBufferHours: undefined as unknown as number,
    }));
    expect(container.courierService.dnpDirectRequiredHours(null, strippedBands, config)).toBeNull();
    expect(container.courierService.dnpDirectRequiredHours(2, strippedBands, config)).toBeGreaterThan(0);
    expect(container.courierService.dnpDirectRequiredHours(4, strippedBands, config)).toBeGreaterThan(0);
    expect(container.courierService.dnpDirectRequiredHours(7, strippedBands, config)).toBeGreaterThan(0);
    expect(container.courierService.dnpDirectRequiredHours(10, strippedBands, config)).toBeGreaterThan(0);
    expect(container.courierService.dnpDirectRequiredHours(16, strippedBands, config)).toBeGreaterThan(0);
    expect(container.courierService.dnpDirectRequiredHours(30, strippedBands, config)).toBeGreaterThan(0);

    // 5. courierComparison with no deadline
    const rfc = container.rfcService.liveHrjRfc(spec, config, clock.now());
    expect(
      container.courierService.courierComparison(spec, rfc, postcodes, bands, config).selected
    ).toBeNull();

    // 6. Non-compressed afternoon window where Gophr is cheaper than DNP (e.g. 10 miles, 26h away)
    spec.devMiles = 10; // 8-12 mi band: gophr £28.27, dnp £36
    spec.deadline = new Date(2026, 9, 30, 16, 0, 0).toISOString();
    const ccGophr = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);
    expect(ccGophr.gophr?.eligible).toBe(true);
    expect(ccGophr.selected?.name).toBe('Gophr');

    // 7. Compressed window (<6h conservative window) where DNP is favoured
    spec.devMiles = 3.4;
    spec.deadline = new Date(2026, 9, 29, 23, 30, 0).toISOString(); // 9.5h from 14:00 -> consWin ~2h
    const ccCompressed = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);
    expect(ccCompressed.selected?.name).toBe('DNP');

    // 8. Very tight window where neither courier is eligible
    spec.deadline = new Date(2026, 9, 29, 18, 0, 0).toISOString(); // 4h from 14:00 -> consWin < 0
    const ccTight = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);
    expect(ccTight.selected).toBeNull();
    expect(container.courierService.deliveryCost(ccTight).total).toBeNull();

    // 9. Overnight / early next-morning DNP selection and OOH
    spec.devMiles = 3.4;
    spec.deadline = new Date(2026, 9, 30, 9, 0, 0).toISOString();
    const ccEarly = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);
    expect(ccEarly.selected?.name).toBe('DNP');
    expect(ccEarly.dnp?.overnight).toBe(true);
    expect(ccEarly.dnp?.ooh).toBeGreaterThan(0);

    expect(container.courierService.distanceBand(null, bands)).toBeNull();
    expect(container.courierService.distanceBand(999, bands)).toBeNull();
    expect(container.courierService.estimatedTravelHours(null, config)).toBeNull();
    expect(container.courierService.normPostcode(' e1  3nl ')).toBe('E13NL');
    expect(
      container.courierService.isOOHAt(new Date(2026, 9, 29, 22, 0, 0), config)
    ).toBe(true);
    expect(
      container.courierService.isOOHAt(new Date(2026, 9, 29, 12, 0, 0), config)
    ).toBe(false);
  });

  it('covers ResilienceService traffic light statuses (WAITING, RED, AMBER, GREEN)', async () => {
    const config = await container.repo.getBusinessConfig();
    const bands = await container.repo.getCourierDistanceBands();
    const postcodes = await container.repo.getPostcodeDistances();
    const spec = container.nlpService.createInitialSpec(config);
    spec.quantity = 25;
    spec.size = 'A5';
    spec.pages = 16;

    const rfc = container.rfcService.liveHrjRfc(spec, config, clock.now());

    // 1. WAITING when no deadline
    const ccNoDl = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);
    const resWait = container.resilienceService.liveResilience(spec, rfc, ccNoDl);
    expect(resWait.status).toBe('WAITING');
    expect(container.resilienceService.feasibility(spec, config, resWait, clock.now()).why).toContain(
      'Exact deadline still required'
    );

    // 2. RED when deadline has passed
    spec.deadline = new Date(2026, 9, 29, 12, 0, 0).toISOString(); // 2h in the past
    const ccPast = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);
    const resPast = container.resilienceService.liveResilience(spec, rfc, ccPast);
    expect(resPast.productionStatus).toBe('RED');
    expect(container.resilienceService.feasibility(spec, config, resPast, clock.now()).why).toBe(
      'Deadline has passed'
    );

    // 3. AMBER when Expected RFC fits, Conservative RFC is after deadline
    spec.devMiles = 3.4;
    spec.deadline = new Date(2026, 9, 29, 19, 30, 0).toISOString(); // 5.5h away
    const ccAmber = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);
    const resAmber = container.resilienceService.liveResilience(spec, rfc, ccAmber);
    expect(resAmber.productionStatus).toBe('AMBER');
    expect(container.resilienceService.feasibility(spec, config, resAmber, clock.now()).ok).toBe(false);

    // 4. Missing mileage -> Delivery AMBER
    spec.devMiles = null;
    spec.postcode = 'SW1A 2AA';
    spec.deadline = new Date(2026, 9, 30, 16, 0, 0).toISOString();
    const ccNoMiles = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);
    const resNoMiles = container.resilienceService.liveResilience(spec, rfc, ccNoMiles);
    expect(resNoMiles.deliveryStatus).toBe('AMBER');

    // 5. Quantity exceeds maxQtyForHours -> feasibility false
    spec.quantity = 999;
    spec.devMiles = 3.4;
    const ccGreen = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);
    const resGreen = container.resilienceService.liveResilience(spec, rfc, ccGreen);
    expect(container.resilienceService.feasibility(spec, config, resGreen, clock.now()).why).toBe(
      'Quantity exceeds validated window'
    );

    // 6. Comfortable window -> GREEN production/delivery and feasibility ok
    spec.quantity = 25;
    spec.deadline = new Date(2026, 9, 30, 18, 0, 0).toISOString();
    const rfcComfort = container.rfcService.liveHrjRfc(spec, config, clock.now());
    const ccComfort = container.courierService.courierComparison(spec, rfcComfort, postcodes, bands, config);
    const resComfort = container.resilienceService.liveResilience(spec, rfcComfort, ccComfort);
    expect(resComfort.productionStatus).toBe('GREEN');
    if (ccComfort.selected) {
      expect(['GREEN', 'AMBER']).toContain(resComfort.deliveryStatus);
    }
    const feasComfort = container.resilienceService.feasibility(spec, config, resComfort, clock.now());
    if (resComfort.status === 'GREEN') {
      expect(feasComfort.ok).toBe(true);
    }

    // 7. RED delivery when expected RFC leaves less time than travel
    spec.deadline = new Date(2026, 9, 29, 16, 30, 0).toISOString();
    const rfcRed = container.rfcService.liveHrjRfc(spec, config, clock.now());
    const ccRed = container.courierService.courierComparison(spec, rfcRed, postcodes, bands, config);
    const resRed = container.resilienceService.liveResilience(spec, rfcRed, ccRed);
    expect(['RED', 'AMBER']).toContain(resRed.deliveryStatus);
    expect(container.resilienceService.feasibility(spec, config, resRed, clock.now()).ok).toBe(false);
  });

  it('computes HRJ Pricing V3, DNP Selling Price V1, Compression Barrier, and Standard Price edge cases', async () => {
    const config = await container.repo.getBusinessConfig();
    const hrjJobs = await container.repo.getHrjHistoricalJobs();
    const dnpObs = await container.repo.getDnpSellingObservations();
    const route1Rows = await container.repo.getRoute1StandardPrices();

    const spec = container.nlpService.createInitialSpec(config);
    // Missing fields return null / zeros
    expect(container.pricingService.hrjProductionCost(spec, hrjJobs, clock.now()).expected).toBe(0);
    expect(container.pricingService.dnpSellingPriceV1(spec, 100, dnpObs, config, clock.now())).toBeNull();
    expect(container.pricingService.standardPrice(spec, route1Rows, config)).toBeNull();

    // Urgency buckets: null, <=6, <=12, <=24, <=48, >48
    expect(container.pricingService.hrjUrgencyBucket(null)).toBe(2);
    expect(container.pricingService.hrjUrgencyBucket(4)).toBe(0);
    expect(container.pricingService.hrjUrgencyBucket(10)).toBe(1);
    expect(container.pricingService.hrjUrgencyBucket(20)).toBe(2);
    expect(container.pricingService.hrjUrgencyBucket(36)).toBe(3);
    expect(container.pricingService.hrjUrgencyBucket(60)).toBe(4);

    // Compression barrier at <=0h, 2h, 10h, 25h, null
    expect(container.pricingService.deadlineCompressionBarrier(null, 500, config).premium).toBe(0);
    expect(container.pricingService.deadlineCompressionBarrier(-1, 500, config).premium).toBe(1000);
    expect(container.pricingService.deadlineCompressionBarrier(2, 500, config).premium).toBe(800);
    expect(container.pricingService.deadlineCompressionBarrier(10, 500, config).premium).toBe(175);
    expect(container.pricingService.deadlineCompressionBarrier(25, 500, config).premium).toBe(0);

    // Commercial markup bands
    expect(container.pricingService.commercialMarkup(10, false)).toBe(250);
    expect(container.pricingService.commercialMarkup(20, false)).toBe(225);
    expect(container.pricingService.commercialMarkup(36, true)).toBe(225);
    expect(container.pricingService.commercialMarkup(36, false)).toBe(200);

    // Standard price across supplier cost brackets (<=200, 200-500, >500) and unsupported page count
    spec.size = 'A4';
    spec.pages = 20;
    spec.quantity = 100;
    expect(container.pricingService.standardPrice(spec, route1Rows, config)?.quote).toBeGreaterThan(0);

    spec.quantity = 500;
    expect(container.pricingService.standardPrice(spec, route1Rows, config)?.quote).toBeGreaterThan(0);

    spec.quantity = 2000;
    expect(container.pricingService.standardPrice(spec, route1Rows, config)?.quote).toBeGreaterThan(0);

    spec.pages = 999; // Exceeds max Route1 pages -> null
    expect(container.pricingService.standardPrice(spec, route1Rows, config)).toBeNull();

    expect(container.pricingService.hrjWeightedQuantile([], 0.5)).toBe(0);
    expect(container.pricingService.solveLinear([[0, 0], [0, 0]], [0, 0])).toHaveLength(2);

    const flyerDef = await container.repo.getProductById('flyers-leaflets');
    const bannerDef = await container.repo.getProductById('roller-banners');
    spec.quantity = 250;
    spec.size = 'A6';
    spec.pages = null;
    spec.attributes = { sides: 'Single-sided', stock: '170gsm Silk' };
    spec.deadline = new Date(2026, 9, 30, 16, 0, 0).toISOString();
    expect(container.pricingService.hrjProductionCost(spec, hrjJobs, clock.now(), flyerDef).expected).toBeGreaterThan(0);

    spec.attributes = { sides: 'Double-sided' };
    spec.size = 'A5';
    expect(container.pricingService.dnpSellingPriceV1(spec, 180, dnpObs, config, clock.now(), flyerDef)).not.toBeNull();

    spec.productId = 'roller-banners';
    spec.quantity = 4;
    spec.size = '850mm × 2000mm';
    spec.attributes = { cassette: 'Premium Teardrop Base' };
    expect(container.pricingService.hrjProductionCost(spec, hrjJobs, clock.now(), bannerDef).expected).toBeGreaterThan(0);

    spec.attributes = { cassette: 'Standard Base' };
    expect(container.pricingService.standardPrice(spec, route1Rows, config, bannerDef)?.estimated).toBe(true);

    const unknownDef = { ...flyerDef!, id: 'business-cards' };
    spec.pages = 16;
    spec.size = 'A4';
    expect(container.pricingService.hrjPricingV3(spec, hrjJobs, clock.now(), unknownDef)).not.toBeNull();

    spec.deadline = new Date(2026, 9, 29, 22, 0, 0).toISOString(); // ~8h -> P75
    const sellTight = container.pricingService.dnpSellingPriceV1(spec, 200, dnpObs, config, clock.now());
    expect(sellTight?.selectedPercentile).toBe(75);

    spec.deadline = new Date(2026, 9, 30, 10, 0, 0).toISOString(); // 20h -> P65
    const sellMid = container.pricingService.dnpSellingPriceV1(spec, 200, dnpObs, config, clock.now());
    expect(sellMid?.selectedPercentile).toBe(65);

    spec.deadline = new Date(2026, 10, 1, 14, 0, 0).toISOString(); // 48h -> P50
    const sellWide = container.pricingService.dnpSellingPriceV1(spec, 200, dnpObs, config, clock.now());
    expect(sellWide?.selectedPercentile).toBe(50);

    const unreliable = {
      ...hrjJobs[0],
      urgency_reliable: false,
      size2: 'A6',
    };
    expect(
      container.pricingService.hrjV2Distance(unreliable, {
        qty: 40,
        pages: 16,
        size: 'A5',
        hours_to_deadline: 18,
      })
    ).toBeGreaterThan(0);
  });

  it('evaluates Standard Pricing hold when Route1 has no matching row and A4 Landscape hold under 72h', async () => {
    const spec = container.nlpService.createInitialSpec();
    spec.quantity = 99999; // Unsupported quantity in Route1
    spec.size = 'A4';
    spec.orientation = 'Portrait';
    spec.pages = 20;
    spec.cover = '350gsm Silk';
    spec.inner = '170gsm Silk';
    spec.artwork = 'Ready';
    spec.postcode = 'E1 3NL';
    spec.address = '39 Solent House';
    spec.devMiles = 3.4;
    spec.deadline = new Date(2026, 10, 2, 14, 0, 0).toISOString(); // 96h away

    const evalUnsupportedStd = await container.evaluationService.evaluate(spec, true);
    expect(evalUnsupportedStd.quoteState.mode).toBe('checking');
    expect(evalUnsupportedStd.diagnosticsHtml).toContain('No supported Route1 booklet cost');

    // A4 Landscape under 72h hold
    spec.quantity = 50;
    spec.orientation = 'Landscape';
    spec.deadline = new Date(2026, 9, 30, 14, 0, 0).toISOString(); // 24h away
    const evalLandscapeHold = await container.evaluationService.evaluate(spec, true);
    expect(evalLandscapeHold.quoteState.mode).toBe('checking');
    expect(evalLandscapeHold.diagnosticsHtml).toContain('HRJ excluded: A4 Landscape');

    // Standard pricing success (>= 72h with a Route1 match)
    spec.orientation = 'Portrait';
    spec.quantity = 50;
    spec.deadline = new Date(2026, 10, 2, 14, 0, 0).toISOString();
    const evalStd = await container.evaluationService.evaluate(spec, true);
    expect(evalStd.quoteState.mode).toBe('quote');
    expect(evalStd.quoteState.standard).toBe(true);
    expect(evalStd.diagnosticsHtml).toContain('STANDARD PRICING');

    // Sidebar quote without explicit triggerQuoteCalc
    const evalSidebar = await container.evaluationService.evaluate(spec, false);
    expect(evalSidebar.quoteState.mode).toBe('quote');

    // WAITING diagnostics and invalid deadline formatting
    const waitingSpec = container.nlpService.createInitialSpec();
    waitingSpec.address = '39 Solent House & Co';
    const evalWait = await container.evaluationService.evaluate(waitingSpec, false);
    expect(evalWait.diagnosticsHtml).toContain('WAITING');
    expect(evalWait.progress.quoteInputsComplete).toBe(false);

    const flyer = await container.repo.getProductById('flyers-leaflets');
    const flyerSpec = container.nlpService.createInitialSpec(undefined, flyer!);
    flyerSpec.quantity = 250;
    flyerSpec.size = 'A5';
    flyerSpec.attributes = { size: 'A5', sides: 'Double-sided', stock: '170gsm Silk' };
    flyerSpec.artwork = 'Ready';
    flyerSpec.file = 'art.pdf';
    flyerSpec.postcode = 'E1 3NL';
    flyerSpec.address = '39 Solent House';
    flyerSpec.devMiles = 3.4;
    flyerSpec.deadline = new Date(2026, 9, 30, 16, 0, 0).toISOString();
    const evalFlyer = await container.evaluationService.evaluate(flyerSpec, true);
    expect(evalFlyer.progress.percent).toBeGreaterThan(50);
    expect(evalFlyer.diagnosticsHtml.toLowerCase()).toMatch(/sides|flyer|quantity/);
    expect(container.evaluationService.areProductAttributesComplete(flyerSpec, flyer)).toBe(true);
    expect(container.evaluationService.getAttrValue(flyerSpec, 'sides')).toBe('Double-sided');
    expect(container.evaluationService.getAttrValue(flyerSpec, 'missing')).toBeNull();

    const rfcFlyer = container.rfcService.liveHrjRfc(flyerSpec, await container.repo.getBusinessConfig(), clock.now(), flyer);
    expect(rfcFlyer.expectedHours).toBeGreaterThan(0);

    const banner = await container.repo.getProductById('roller-banners');
    const rfcBanner = container.rfcService.liveHrjRfc(
      { ...flyerSpec, quantity: 80, size: 'A4', productId: 'roller-banners' },
      await container.repo.getBusinessConfig(),
      clock.now(),
      banner
    );
    expect(rfcBanner.confidence).toBe('Low');

    const bannerSpec2 = container.nlpService.createInitialSpec(undefined, banner!);
    bannerSpec2.quantity = 50;
    bannerSpec2.size = '850mm × 2000mm';
    bannerSpec2.attributes = { size: '850mm × 2000mm', cassette: 'Standard Base' };
    bannerSpec2.artwork = 'Ready';
    bannerSpec2.postcode = 'E1 3NL';
    bannerSpec2.address = '39 Solent House';
    bannerSpec2.devMiles = 3.4;
    bannerSpec2.deadline = new Date(2026, 10, 2, 14, 0, 0).toISOString();
    const evalBannerStd = await container.evaluationService.evaluate(bannerSpec2, true);
    expect(evalBannerStd.quoteState.mode).toBe('quote');
    expect(evalBannerStd.quoteState.vatRate).toBe(0.2);
    expect(evalBannerStd.quoteState.priceSubtext).toContain('VAT');
  });

  it('covers remaining Resilience delivery lights for DNP, Gophr, overnight, and no-courier RED', async () => {
    const config = await container.repo.getBusinessConfig();
    const spec = container.nlpService.createInitialSpec(config);
    spec.quantity = 25;
    spec.size = 'A5';
    spec.pages = 16;
    spec.devMiles = 3.4;
    spec.deadline = new Date(2026, 9, 30, 18, 0, 0).toISOString();
    const rfc = container.rfcService.liveHrjRfc(spec, config, clock.now());
    const dist = { miles: 3.4, source: 'test', label: '3.4 mi' };

    const dnpGreen = container.resilienceService.liveResilience(spec, rfc, {
      dist,
      band: null,
      gophr: null,
      dnp: null,
      selected: {
        name: 'DNP',
        eligible: true,
        baseline: 18,
        protected: 18,
        requiredWindow: 1,
        overnight: false,
        reason: 'ok',
      },
      travel: 0.5,
    });
    expect(dnpGreen.deliveryStatus).toBe('GREEN');
    expect(dnpGreen.productionStatus).toBe('GREEN');

    const dnpAmber = container.resilienceService.liveResilience(spec, rfc, {
      dist,
      band: null,
      gophr: null,
      dnp: null,
      selected: {
        name: 'DNP',
        eligible: true,
        baseline: 18,
        protected: 18,
        requiredWindow: 22,
        overnight: false,
        reason: 'tight',
      },
      travel: 0.5,
    });
    expect(dnpAmber.deliveryStatus).toBe('AMBER');

    const gophrGreen = container.resilienceService.liveResilience(spec, rfc, {
      dist,
      band: null,
      gophr: null,
      dnp: null,
      selected: {
        name: 'Gophr',
        eligible: true,
        baseline: 12,
        protected: 12,
        overnight: false,
        reason: 'ok',
      },
      travel: 0.5,
    });
    expect(gophrGreen.deliveryStatus).toBe('GREEN');

    spec.deadline = new Date(2026, 9, 29, 21, 0, 0).toISOString();
    const rfcTight = container.rfcService.liveHrjRfc(spec, config, clock.now());
    const gophrAmber = container.resilienceService.liveResilience(spec, rfcTight, {
      dist,
      band: null,
      gophr: null,
      dnp: null,
      selected: {
        name: 'Gophr',
        eligible: true,
        baseline: 12,
        protected: 12,
        overnight: false,
        reason: 'ok',
      },
      travel: 4,
    });
    expect(['AMBER', 'RED']).toContain(gophrAmber.deliveryStatus);

    const overnight = container.resilienceService.liveResilience(spec, rfcTight, {
      dist,
      band: null,
      gophr: null,
      dnp: null,
      selected: {
        name: 'DNP',
        eligible: true,
        baseline: 18,
        protected: 28,
        overnight: true,
        reason: 'overnight',
      },
      travel: 0.5,
    });
    expect(['GREEN', 'AMBER']).toContain(overnight.deliveryStatus);

    spec.deadline = new Date(2026, 9, 29, 16, 0, 0).toISOString();
    const rfcRed = container.rfcService.liveHrjRfc(spec, config, clock.now());
    const noCourierRed = container.resilienceService.liveResilience(spec, rfcRed, {
      dist,
      band: null,
      gophr: null,
      dnp: null,
      selected: null,
      travel: 3,
    });
    expect(noCourierRed.deliveryStatus).toBe('RED');
  });
});
