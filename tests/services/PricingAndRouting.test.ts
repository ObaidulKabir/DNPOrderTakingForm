import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/domain/clock.js';
import { InMemoryDataRepository } from '../../src/repositories/InMemoryDataRepository.js';
import { JsonCsvDataRepository } from '../../src/repositories/JsonCsvDataRepository.js';
import { createContainer, ServiceContainer } from '../../src/container.js';

describe('Pricing, Routing, RFC, Courier & Resilience Services', () => {
  let container: ServiceContainer;
  let clock: FixedClock;

  beforeEach(async () => {
    const fileRepo = new JsonCsvDataRepository();
    const memoryRepo = await InMemoryDataRepository.fromRepository(fileRepo);
    // Thursday 14:00 local time
    clock = new FixedClock(new Date(2026, 9, 29, 14, 0, 0));
    container = createContainer(memoryRepo, clock);
  });

  it('evaluates PrintedEasy eligibility before and after 15:30 weekday cutoff', async () => {
    const config = await container.repo.getBusinessConfig();
    const spec = container.nlpService.createInitialSpec(config);
    // Friday 19:00 deadline (after standardDeliveryDay 18:00)
    spec.deadline = new Date(2026, 9, 30, 19, 0, 0).toISOString();

    const peBeforeCutoff = container.routingService.peRoute(spec, config, clock.now());
    expect(peBeforeCutoff.eligible).toBe(true);
    expect(peBeforeCutoff.reason).toContain('PE cutoff and delivery calendar fit deadline');

    // Move clock to 16:05 (after 15:30 payment cutoff)
    clock.setNow(new Date(2026, 9, 29, 16, 5, 0));
    const peAfterCutoff = container.routingService.peRoute(spec, config, clock.now());
    expect(peAfterCutoff.eligible).toBe(false);
    expect(peAfterCutoff.reason).toContain('Customer payment cutoff 15:30 has passed');
  });

  it('requires HRJ overnight collection when deadline is before 13:00 tomorrow', async () => {
    const config = await container.repo.getBusinessConfig();
    const spec = container.nlpService.createInitialSpec(config);
    spec.deadline = new Date(2026, 9, 30, 10, 0, 0).toISOString(); // 20h away, 10:00 AM tomorrow

    const hrj = container.routingService.hrjRoute(spec, config, clock.now());
    expect(hrj.eligible).toBe(true);
    expect(hrj.overnight).toBe(true);
    expect(hrj.route).toContain('held overnight');
  });

  it('selects DNP with £20 OOH surcharge for early-morning next-day delivery and marks Gophr ineligible', async () => {
    const config = await container.repo.getBusinessConfig();
    const bands = await container.repo.getCourierDistanceBands();
    const postcodes = await container.repo.getPostcodeDistances();

    const spec = container.nlpService.createInitialSpec(config);
    spec.quantity = 100;
    spec.size = 'A4';
    spec.pages = 20;
    spec.devMiles = 3.4;
    spec.deadline = new Date(2026, 9, 30, 10, 0, 0).toISOString(); // 10:00 AM tomorrow

    const rfc = container.rfcService.liveHrjRfc(spec, config, clock.now());
    const cc = container.courierService.courierComparison(spec, rfc, postcodes, bands, config);

    expect(cc.gophr?.eligible).toBe(false);
    expect(cc.dnp?.eligible).toBe(true);
    expect(cc.dnp?.ooh).toBe(20);
    expect(cc.selected?.name).toBe('DNP');
    expect(cc.selected?.protected).toBe(35); // £15 baseline (3-5 mi) + £20 OOH
  });

  it('computes HRJ Pricing V3, DNP Selling Price V1, and Deadline Compression Barrier accurately', async () => {
    const config = await container.repo.getBusinessConfig();
    const hrjJobs = await container.repo.getHrjHistoricalJobs();
    const dnpObs = await container.repo.getDnpSellingObservations();

    const spec = container.nlpService.createInitialSpec(config);
    spec.quantity = 100;
    spec.size = 'A4';
    spec.orientation = 'Portrait';
    spec.pages = 20;
    spec.cover = '350gsm Silk';
    spec.inner = '170gsm Silk';
    spec.artwork = 'Ready';
    spec.postcode = 'E1 3NL';
    spec.address = '39 Solent House';
    spec.devMiles = 3.4;
    spec.deadline = new Date(2026, 9, 30, 10, 0, 0).toISOString(); // 20h away

    const hrjCost = container.pricingService.hrjProductionCost(spec, hrjJobs, clock.now());
    expect(hrjCost.expected).toBeGreaterThan(100);
    expect(hrjCost.conservative).toBeGreaterThanOrEqual(hrjCost.expected + 35);

    const selling = container.pricingService.dnpSellingPriceV1(
      spec,
      hrjCost.conservative + 35,
      dnpObs,
      config,
      clock.now()
    );
    expect(selling).not.toBeNull();
    expect(selling!.selectedPercentile).toBe(65); // 20h <= 24h -> P65
    expect(selling!.quote % 5).toBe(0);

    // 20h has 0 compression premium; 6h has £400 compression premium
    const comp20 = container.pricingService.deadlineCompressionBarrier(20, selling!.quote, config);
    expect(comp20.premium).toBe(0);

    const comp6 = container.pricingService.deadlineCompressionBarrier(6, selling!.quote, config);
    expect(comp6.premium).toBe(400);
    expect(comp6.total).toBe(selling!.quote + 400);
  });

  it('uses Route1 standard pricing when deadline is >= 72 hours away', async () => {
    const spec = container.nlpService.createInitialSpec();
    spec.quantity = 100;
    spec.size = 'A4';
    spec.orientation = 'Portrait';
    spec.pages = 20;
    spec.cover = '350gsm Silk';
    spec.inner = '170gsm Silk';
    spec.artwork = 'Ready';
    spec.postcode = 'E1 3NL';
    spec.address = '39 Solent House';
    spec.devMiles = 3.4;
    // 4 days (96h) away
    spec.deadline = new Date(2026, 10, 2, 14, 0, 0).toISOString();

    const evaluation = await container.evaluationService.evaluate(spec, true);
    expect(evaluation.quoteState.mode).toBe('quote');
    expect(evaluation.quoteState.standard).toBe(true);
    expect(evaluation.diagnosticsData.standardPrice).not.toBeNull();
    expect(evaluation.quoteState.total).toBe(evaluation.diagnosticsData.standardPrice!.quote);
  });

  it('holds quote when A4 Landscape is requested under 72 hours', async () => {
    const spec = container.nlpService.createInitialSpec();
    spec.quantity = 50;
    spec.size = 'A4';
    spec.orientation = 'Landscape';
    spec.pages = 16;
    spec.cover = '350gsm Silk';
    spec.inner = '170gsm Silk';
    spec.artwork = 'Ready';
    spec.postcode = 'E1 3NL';
    spec.address = '39 Solent House';
    spec.devMiles = 3.4;
    spec.deadline = new Date(2026, 9, 30, 14, 0, 0).toISOString(); // 24h away

    const evaluation = await container.evaluationService.evaluate(spec, true);
    expect(evaluation.quoteState.mode).toBe('checking');
    expect(evaluation.diagnosticsHtml).toContain('HRJ excluded: A4 Landscape cannot be produced on its machine');
  });
});
