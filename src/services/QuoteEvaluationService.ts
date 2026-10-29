import { IClock } from '../domain/clock.js';
import {
  BusinessConfig,
  CourierOptionEvaluation,
  EvaluationResponse,
  LiveResilienceResult,
  OrderSpecification,
  ProductDefinition,
} from '../domain/types.js';
import { IDataRepository } from '../repositories/IDataRepository.js';
import { CourierService } from './CourierService.js';
import { PricingService } from './PricingService.js';
import { ResilienceService } from './ResilienceService.js';
import { RfcForecastService } from './RfcForecastService.js';
import { SupplierRoutingService } from './SupplierRoutingService.js';

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] || m)
  );
}

function fmtDT(isoOrDate: string | Date | null | undefined): string {
  if (!isoOrDate) return '—';
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function money(x: number | null | undefined): string {
  return x == null ? '—' : `£${x.toFixed(2)}`;
}

function courierLine(x: CourierOptionEvaluation | null | undefined): string {
  if (!x) return '—';
  return `${x.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'} · baseline ${money(x.baseline)} · protected ${money(
    x.protected
  )}${x.ooh ? ` (includes £${x.ooh.toFixed(0)} OOH)` : ''}<br>Reason: ${x.reason}`;
}

export class QuoteEvaluationService {
  constructor(
    private readonly repo: IDataRepository,
    private readonly clock: IClock,
    private readonly routingService: SupplierRoutingService,
    private readonly rfcService: RfcForecastService,
    private readonly courierService: CourierService,
    private readonly resilienceService: ResilienceService,
    private readonly pricingService: PricingService
  ) {}

  getAttrValue(spec: OrderSpecification, key: string): unknown {
    if (spec[key] !== undefined && spec[key] !== null && spec[key] !== '') {
      return spec[key];
    }
    if (spec.attributes && spec.attributes[key] !== undefined && spec.attributes[key] !== null && spec.attributes[key] !== '') {
      return spec.attributes[key];
    }
    return null;
  }

  areProductAttributesComplete(spec: OrderSpecification, productDef?: ProductDefinition | null): boolean {
    if (!productDef || productDef.id === 'saddle-stitched-booklets') {
      return !!(spec.size && spec.orientation && spec.pages && spec.cover && spec.inner);
    }
    for (const attr of productDef.attributes) {
      if (attr.required && !this.getAttrValue(spec, attr.attributeKey)) {
        return false;
      }
    }
    return true;
  }

  quoteInputsComplete(spec: OrderSpecification, productDef?: ProductDefinition | null): boolean {
    return !!(
      spec.deadline &&
      spec.quantity &&
      this.areProductAttributesComplete(spec, productDef) &&
      spec.artwork !== null &&
      spec.postcode &&
      spec.address &&
      spec.devMiles != null
    );
  }

  specReadyForSidebarQuote(spec: OrderSpecification, productDef?: ProductDefinition | null): boolean {
    return !!(
      spec.deadline &&
      spec.quantity &&
      this.areProductAttributesComplete(spec, productDef) &&
      spec.artwork &&
      spec.postcode &&
      spec.address
    );
  }

  computeProgress(
    spec: OrderSpecification,
    productDef?: ProductDefinition | null
  ): EvaluationResponse['progress'] {
    const productFields: Array<[string, unknown]> = [];
    if (!productDef || productDef.id === 'saddle-stitched-booklets') {
      productFields.push(
        ['Finished size', spec.size],
        ['Orientation', spec.orientation],
        ['Pages', spec.pages ? `${spec.pages}pp incl. cover` : null],
        ['Cover', spec.cover],
        ['Inner pages', spec.inner]
      );
    } else {
      for (const attr of productDef.attributes) {
        const val = this.getAttrValue(spec, attr.attributeKey);
        productFields.push([attr.label, val ? `${val}${attr.suffix ? ' ' + attr.suffix : ''}` : null]);
      }
    }

    const fields: Array<[string, unknown]> = [
      ['Product', productDef?.singularName || spec.product || 'Saddle-stitched booklet'],
      ['Quantity', spec.quantity],
      ...productFields,
      ['Artwork', spec.file ? 'Uploaded' : spec.artwork],
      ['Delivery postcode', spec.postcode],
      ['Delivery address', spec.address],
      ['Required by', spec.deadline ? fmtDT(spec.deadline) : null],
    ];
    const done = fields.filter((x) => Boolean(x[1])).length;
    const total = fields.length;
    const percent = Math.round((done / total) * 100);
    const missingFields = fields.filter((x) => !x[1]).map((x) => x[0]);

    return {
      done,
      total,
      percent,
      progressText: percent === 100 ? 'Specification complete' : `${done} of ${total} details collected`,
      missingFields,
      isComplete: missingFields.length === 0,
      quoteInputsComplete: this.quoteInputsComplete(spec, productDef),
    };
  }

  private buildLiveDiagnosticsHTML(params: {
    spec: OrderSpecification;
    productDef: ProductDefinition | null;
    config: BusinessConfig;
    live: LiveResilienceResult;
    hoursLeft: number | null;
    pe: ReturnType<SupplierRoutingService['peRoute']>;
    hrjRoute: ReturnType<SupplierRoutingService['hrjRoute']>;
    hrjCost: ReturnType<PricingService['hrjProductionCost']>;
    del: ReturnType<CourierService['deliveryCost']>;
    protectedFulfilment: number | null;
    selling: ReturnType<PricingService['dnpSellingPriceV1']>;
    basePreview: number | null;
    compression: ReturnType<PricingService['deadlineCompressionBarrier']>;
  }): string {
    const {
      spec,
      productDef,
      config,
      live: f,
      hoursLeft: h,
      pe,
      hrjRoute: hr,
      hrjCost: hrj,
      del,
      protectedFulfilment,
      selling,
      basePreview,
      compression,
    } = params;

    if (f.status === 'WAITING' || !f.rfc || !f.couriers) {
      return `<strong>LIVE ENQUIRY</strong><br>Status: WAITING<br>${f.reasons[0]}`;
    }

    const d = f.rfc;
    const c = f.couriers;
    const dist = c.dist;
    const preview = compression.total;
    const prodDeadlineDelta = f.conservativeBuffer ?? 0;
    const mk = this.pricingService.commercialMarkup(h, hr.overnight);
    const vatRate = productDef?.vatRate ?? 0;
    const vatAmount = preview != null ? preview * vatRate : 0;

    let specSummaryLines = '';
    if (!productDef || productDef.id === 'saddle-stitched-booklets') {
      specSummaryLines = `Quantity: ${spec.quantity || '—'} · Size: ${spec.size || '—'} · Pages: ${
        spec.pages || '—'
      }pp including cover<br>
 Cover: ${spec.cover || '—'} · Inner: ${spec.inner || '—'}<br>`;
    } else {
      const attrParts = productDef.attributes
        .map((a) => `${a.label}: ${esc(this.getAttrValue(spec, a.attributeKey) || '—')}`)
        .join(' · ');
      specSummaryLines = `Quantity: ${spec.quantity || '—'} · ${attrParts}<br>`;
    }

    return `<strong>LIVE ENQUIRY — ${f.status}</strong><br>
 Source: current customer form/conversation<br><br>
 <strong>1. CUSTOMER SPECIFICATION</strong><br>
 Product: ${esc(productDef?.name || config.productName)}<br>
 ${specSummaryLines}
 Artwork: ${spec.file ? 'Uploaded — ' + esc(spec.file) : spec.artwork || '—'}<br>
 Destination: ${esc(spec.postcode || '—')} · ${esc(spec.address || '—')}<br>
 Exact deadline: ${fmtDT(spec.deadline)}<br>
 Hours remaining now: ${(h ?? 0).toFixed(2)}h<br><br>

 <strong>2. SUPPLIER ROUTING</strong><br>
 PrintedEasy: ${pe.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}<br>
 PE reason: ${pe.reason}<br>
 PE cutoff rule: ${pe.cutoff}<br>
 HRJ: ${hr.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}<br>
 HRJ reason: ${hr.reason}<br>
 HRJ operating model: flexible/manual urgent production window<br>
 Production model used below: HRJ historical booklet RFC model V1<br><br>

 <strong>3. PRODUCTION FORECAST — ${f.productionStatus}</strong><br>
 Evaluation time: ${fmtDT(d.start)}<br>
 Expected RFC: ${fmtDT(d.expectedRfc)} (${d.expectedHours.toFixed(2)}h from now)<br>
 Conservative RFC: ${fmtDT(d.conservativeRfc)} (${d.conservativeHours.toFixed(2)}h from now)<br>
 RFC confidence: ${d.confidence}<br>
 Expected RFC → deadline: ${(f.expectedBuffer ?? 0).toFixed(2)}h<br>
 Conservative RFC → deadline: ${(f.conservativeBuffer ?? 0).toFixed(2)}h<br>
 Production interpretation: ${f.productionReason}<br>
 ${
   prodDeadlineDelta < 0
     ? `<strong>⚠ Conservative production runs ${Math.abs(prodDeadlineDelta).toFixed(2)}h beyond the requested deadline.</strong><br>`
     : ''
 }<br>

 <strong>4. DELIVERY / MILEAGE — ${f.deliveryStatus}</strong><br>
 Collection origin: ${esc(config.hrjRouting.originAddress)}<br>
 Destination postcode: ${esc(spec.postcode || '—')}<br>
 HRJ → destination road distance: ${
   dist.miles == null ? 'ROUTING INTEGRATION REQUIRED' : dist.miles.toFixed(1) + ' miles'
 }<br>
 Distance source: ${dist.source}<br>
 ${
   spec.devMiles != null
     ? '<strong>⚠ Test mileage is a developer override, not postcode-derived.</strong><br>'
     : ''
 }
 Distance band: ${c.band ? c.band.label : '—'}<br>
 Planning collection/travel allowance: ${
   c.travel == null ? '—' : (c.travel * 60).toFixed(0) + ' min'
 }<br>
 Expected RFC → deadline courier window: ${
   c.expectedWindow == null ? '—' : c.expectedWindow.toFixed(2) + 'h'
 }<br>
 Conservative RFC → deadline courier window: ${
   c.conservativeWindow == null ? '—' : c.conservativeWindow.toFixed(2) + 'h'
 }<br><br>

 <strong>5. COURIER COMPARISON</strong><br>
 GOPHR: ${courierLine(c.gophr)}<br><br>
 DNP: ${courierLine(c.dnp)}<br><br>
 Selected courier: ${c.selected ? c.selected.name : 'NOT YET SELECTABLE'}<br>
 Selected route: ${f.route}<br>
 Recovery after planning collection/travel: ${
   f.recovery == null ? '—' : f.recovery.toFixed(2) + 'h'
 }<br><br>

 <strong>6. HRJ PRICING MODEL V3 — BO1 + BO2</strong><br>
 Model: ${hrj.model ? hrj.model.model : '—'}<br>
 Historical support: ${hrj.model ? hrj.model.support : '—'} · effective support ${
   hrj.model ? hrj.model.effectiveSupport.toFixed(1) : '—'
 }<br>
 Negotiation target: ${hrj.model ? money(hrj.model.target) : '—'}<br>
 Expected negotiated settlement: ${money(hrj.expected)}<br>
 Weighted historical median: ${hrj.model ? money(hrj.model.median) : '—'}<br>
 Weighted P80: ${hrj.model ? money(hrj.model.p80) : '—'} · P90: ${
   hrj.model ? money(hrj.model.p90) : '—'
 }<br>
 <strong>Protected HRJ allowance used for pricing: ${money(hrj.conservative)}</strong><br>
 Structural fallback estimate: ${hrj.model ? money(hrj.model.structural) : '—'}<br><br>
 <strong>Most influential historical HRJ jobs</strong><br>
 ${
   hrj.model
     ? hrj.model.comparables
         .slice(0, 6)
         .map(
           (x, i) =>
             `${i + 1}. #${x.order_id} — ${x.qty} × ${x.size2}, ${x.pages}pp — actual HRJ ${money(
               x.vendor_due
             )} · distance ${x.distance.toFixed(2)}`
         )
         .join('<br>')
     : '—'
 }<br><br>
 <strong>7. COST / CUSTOMER PRICE BUILD-UP</strong><br>
 ${
   del.total == null
     ? `Courier cost: PENDING — mileage/route required<br>
 Protected fulfilment cost: PENDING<br>
 Commercial markup band selected: ${mk}%<br>
 Customer price: PENDING — do not invent courier cost<br>`
     : `Selected courier: ${del.courier}<br>
 Courier baseline: ${money(del.baseline)}<br>
 OOH surcharge: ${money(del.ooh)}<br>
 Protected courier cost: ${money(del.total)}<br>
 Protected fulfilment cost: ${money(protectedFulfilment)}<br>
 <strong>DNP SELLING PRICE MODEL V1 — BO1 + BO2</strong><br>
 ${
   selling
     ? `Historical support: ${selling.support} · effective support ${selling.effectiveSupport.toFixed(1)}<br>
 P25: ${money(selling.p25)} · Median: ${money(selling.p50)} · P65: ${money(selling.p65)} · P75: ${money(
         selling.p75
       )} · P90: ${money(selling.p90)}<br>
 Commercial position: P${selling.selectedPercentile} = ${money(selling.historical)}<br>
 Protected-cost floor: ${money(selling.floor)}<br>
 Base commercial quote: ${money(basePreview)}<br>
 Deadline compression premium: ${money(compression.premium)}<br>
 Indicative customer total: <strong>${money(preview != null ? preview + vatAmount : null)}</strong><br>`
     : 'Selling price pending delivery cost<br>'
 }
 VAT (${Math.round(vatRate * 100)}%): ${money(vatAmount)}<br>`
 }<br>

 <strong>8. FINAL AUTOMATION DECISION — ${f.status}</strong><br>
 ${f.reasons.map((x) => '• ' + x).join('<br>')}<br>
 • Automatic payment: ${f.auto ? 'ALLOWED' : 'HELD'}<br><br>
 <span style="color:#98a2b3">Production and delivery are scored separately. Missing mileage cannot hide a production warning. Courier figures use BO2 historical distance-band baselines; they are not live courier quotes.</span>`;
  }

  async evaluate(spec: OrderSpecification, triggerQuoteCalc: boolean = false): Promise<EvaluationResponse> {
    const now = this.clock.now();
    const productId = spec.productId || 'saddle-stitched-booklets';

    const [config, productDef, capabilities, hrjJobsAll, dnpObsAll, route1Rows, bands, postcodeMap] =
      await Promise.all([
        this.repo.getBusinessConfig(),
        this.repo.getProductById(productId),
        this.repo.getSupplierCapabilities(productId),
        this.repo.getHrjHistoricalJobs(),
        this.repo.getDnpSellingObservations(),
        this.repo.getRoute1StandardPrices(),
        this.repo.getCourierDistanceBands(),
        this.repo.getPostcodeDistances(),
      ]);

    const progress = this.computeProgress(spec, productDef);
    const h = this.routingService.hoursLeft(spec, now);
    const rfc = this.rfcService.liveHrjRfc(spec, config, now, productDef);
    const courierComp = this.courierService.courierComparison(spec, rfc, postcodeMap, bands, config);
    const live = this.resilienceService.liveResilience(spec, rfc, courierComp);
    const feas = this.resilienceService.feasibility(spec, config, live, now, capabilities);

    const pe = spec.deadline ? this.routingService.peRoute(spec, config, now) : null;
    const hrjRoute = spec.deadline ? this.routingService.hrjRoute(spec, config, now) : null;
    const hrjCost = this.pricingService.hrjProductionCost(spec, hrjJobsAll, now, productDef);
    const del = this.courierService.deliveryCost(courierComp);
    const protectedFulfilment = del.total == null ? null : hrjCost.conservative + del.total;
    const selling =
      protectedFulfilment == null
        ? null
        : this.pricingService.dnpSellingPriceV1(spec, protectedFulfilment, dnpObsAll, config, now, productDef);
    const basePreview = selling ? selling.quote : null;
    const compression = this.pricingService.deadlineCompressionBarrier(h, basePreview, config, productDef);
    const stPrice = this.pricingService.standardPrice(spec, route1Rows, config, productDef);

    let diagnosticsHtml = this.buildLiveDiagnosticsHTML({
      spec,
      productDef,
      config,
      live,
      hoursLeft: h,
      pe: pe ?? this.routingService.peRoute(spec, config, now),
      hrjRoute: hrjRoute ?? this.routingService.hrjRoute(spec, config, now),
      hrjCost,
      del,
      protectedFulfilment,
      selling,
      basePreview,
      compression,
    });

    const shouldQuote = triggerQuoteCalc || this.specReadyForSidebarQuote(spec, productDef);
    let quoteState: EvaluationResponse['quoteState'] = {
      mode: 'incomplete',
      standard: false,
      total: null,
      commitmentText: null,
      priceSubtext: null,
    };

    if (shouldQuote && spec.deadline) {
      const dlDate = new Date(spec.deadline);
      const commitmentText = dlDate.toLocaleString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      });

      const exclusionReason = this.routingService.checkSupplierExclusions(spec, h, capabilities);
      const standardThreshold =
        productDef?.pricingConfig.standardThresholdHours ?? config.pricingRules.standardThresholdHours;
      const vatRate = productDef?.vatRate ?? 0;

      if (exclusionReason) {
        quoteState = {
          mode: 'checking',
          standard: false,
          total: null,
          commitmentText,
          priceSubtext: null,
          whyHeld: exclusionReason,
        };
        diagnosticsHtml = exclusionReason;
      } else if (h !== null && h >= standardThreshold) {
        if (!stPrice) {
          quoteState = {
            mode: 'checking',
            standard: true,
            total: null,
            commitmentText,
            priceSubtext: null,
            whyHeld:
              'No supported Route1 booklet cost for this size, page count and quantity; manual quotation required.',
          };
          diagnosticsHtml =
            'No supported Route1 booklet cost for this size, page count and quantity; manual quotation required.';
        } else {
          const vatAmount = Math.round(stPrice.quote * vatRate);
          const finalTotal = stPrice.quote + vatAmount;
          quoteState = {
            mode: 'quote',
            standard: true,
            total: finalTotal,
            vatRate,
            vatAmount,
            commitmentText,
            priceSubtext:
              vatRate > 0
                ? `indicative total · incl. ${Math.round(vatRate * 100)}% VAT (£${vatAmount})`
                : 'indicative total · booklet VAT £0',
          };
          diagnosticsHtml = `<strong>STANDARD PRICING V11</strong><br>Supplier benchmark: Route1 CSV (Express, 150gsm silk, long-edge bound)<br>Matched reference: ${stPrice.qty} copies / ${stPrice.page}pp / ${spec.size}<br>CSV production price: £${stPrice.supplier.toFixed(2)}<br>Indicative fulfilment allowance: £${stPrice.deliveryAllowance.toFixed(2)}<br>Commercial pricing: smooth markup curve<br><strong>Customer quote: £${finalTotal.toFixed(2)}</strong><br>${
            stPrice.estimated ? 'Rounded UP to next available supplier quantity/pages; estimate only.<br>' : ''
          }Supplier selection remains internal. No live vendor booking or price confirmation.`;
        }
      } else if (!feas.ok || compression.total == null || protectedFulfilment == null) {
        quoteState = {
          mode: 'checking',
          standard: false,
          total: null,
          commitmentText,
          priceSubtext: null,
          whyHeld: feas.why,
        };
        diagnosticsHtml = `${diagnosticsHtml}<br><br><strong>PAYMENT HOLD</strong><br>${feas.why}<br>No payment is taken.`;
      } else {
        const vatAmount = Math.round(compression.total * vatRate);
        const finalTotal = Math.round(compression.total + vatAmount);
        quoteState = {
          mode: 'quote',
          standard: false,
          total: finalTotal,
          vatRate,
          vatAmount,
          commitmentText,
          priceSubtext:
            vatRate > 0
              ? `total · incl. ${Math.round(vatRate * 100)}% VAT`
              : 'total · no VAT on booklets',
          botCompletionMessage:
            "That's everything I need. I've checked the specification against your <strong>exact latest delivery time</strong>. Your quotation is ready on the right.",
        };
        diagnosticsHtml = `${diagnosticsHtml}<br><br><strong>PRICING</strong><br>HRJ expected settlement: £${hrjCost.expected.toFixed(
          2
        )}<br>HRJ protected settlement: £${hrjCost.conservative.toFixed(2)}<br>Selected courier: ${
          del.courier
        }<br>Courier baseline: ${money(del.baseline)}<br>OOH surcharge: ${money(
          del.ooh
        )}<br>Protected courier cost: ${money(del.total)}<br>Protected fulfilment cost: £${protectedFulfilment.toFixed(
          2
        )}<br>${
          selling
            ? `Historical P25 / Median / P65 / P75 / P90: ${money(selling.p25)} / ${money(
                selling.p50
              )} / ${money(selling.p65)} / ${money(selling.p75)} / ${money(
                selling.p90
              )}<br>Commercial position: P${selling.selectedPercentile}<br>Protected-cost floor: ${money(
                selling.floor
              )}<br>`
            : ''
        }<strong>Customer total: £${finalTotal.toFixed(2)}</strong> · VAT £${vatAmount.toFixed(2)}`;
      }
    }

    return {
      spec,
      productDef: productDef ?? undefined,
      progress,
      quoteState,
      diagnosticsHtml,
      diagnosticsData: {
        hoursLeft: h,
        feasibility: feas,
        peRoute: pe,
        hrjRoute,
        hrjCost,
        sellingModel: selling,
        compression,
        standardPrice: stPrice,
      },
    };
  }
}
