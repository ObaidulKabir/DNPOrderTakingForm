import {
  BusinessConfig,
  DeadlineCompressionResult,
  DnpSellingComparable,
  DnpSellingObservation,
  DnpSellingPriceModelResult,
  HrjComparableJob,
  HrjHistoricalJob,
  HrjPricingModelResult,
  HrjProductionCostResult,
  OrderSpecification,
  ProductDefinition,
  Route1BookletPriceRow,
  StandardPriceResult,
} from '../domain/types.js';
import { SupplierRoutingService } from './SupplierRoutingService.js';

export class PricingService {
  constructor(private readonly routingService: SupplierRoutingService) {}

  hrjUrgencyBucket(h: number | null | undefined): number {
    if (h == null || !Number.isFinite(h)) return 2;
    if (h <= 6) return 0;
    if (h <= 12) return 1;
    if (h <= 24) return 2;
    if (h <= 48) return 3;
    return 4;
  }

  hrjV2Distance(
    r: HrjHistoricalJob,
    q: { qty: number; pages: number; size: string; hours_to_deadline: number }
  ): number {
    const qd = Math.abs(Math.log((r.qty + 5) / (q.qty + 5)));
    const pd = Math.abs(r.pages - q.pages) / Math.max(q.pages, 12);
    const sd = r.size2 === q.size ? 0 : 0.85;
    const ud =
      r.urgency_reliable === false
        ? 0
        : Math.abs(this.hrjUrgencyBucket(r.hours_to_deadline) - this.hrjUrgencyBucket(q.hours_to_deadline)) * 0.12;
    return 1.35 * qd + 2.25 * pd + sd + ud;
  }

  hrjWeightedQuantile(rows: Array<{ vendor_due: number; weight: number }>, p: number): number {
    const a = rows
      .filter((r) => r.weight > 0)
      .slice()
      .sort((x, y) => x.vendor_due - y.vendor_due);
    const total = a.reduce((z, r) => z + r.weight, 0);
    let c = 0;
    for (const r of a) {
      c += r.weight;
      if (c >= p * total) return r.vendor_due;
    }
    return a.length ? a[a.length - 1].vendor_due : 0;
  }

  solveLinear(A: number[][], b: number[]): number[] {
    const n = b.length;
    const M = A.map((r, i) => r.slice().concat([b[i]]));
    for (let i = 0; i < n; i++) {
      let k = i;
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(M[j][i]) > Math.abs(M[k][i])) k = j;
      }
      [M[i], M[k]] = [M[k], M[i]];
      const d = M[i][i];
      if (Math.abs(d) < 1e-10) continue;
      for (let j = i; j <= n; j++) M[i][j] /= d;
      for (let k2 = 0; k2 < n; k2++) {
        if (k2 !== i) {
          const f = M[k2][i];
          for (let j = i; j <= n; j++) M[k2][j] -= f * M[i][j];
        }
      }
    }
    return M.map((r) => r[n]);
  }

  hrjStructuralEstimate(
    rows: Array<HrjHistoricalJob & { recency: number }>,
    q: { qty: number; pages: number; size: string; hours_to_deadline: number }
  ): number {
    const P = 5;
    const A = Array.from({ length: P }, () => Array(P).fill(0));
    const B = Array(P).fill(0);
    for (const r of rows) {
      const x = [
        1,
        Math.log1p(r.qty),
        Math.log(Math.max(r.pages, 4) / 12),
        r.size2 === 'A4' ? 1 : 0,
        Math.max(0, Math.min(72, r.hours_to_deadline == null ? 24 : r.hours_to_deadline)) / 24,
      ];
      const w = r.recency;
      const y = Math.log(r.vendor_due);
      for (let i = 0; i < P; i++) {
        B[i] += w * x[i] * y;
        for (let j = 0; j < P; j++) {
          A[i][j] += w * x[i] * x[j];
        }
      }
    }
    const lam = [0, 0.8, 1.2, 1.2, 2.0];
    for (let i = 0; i < P; i++) A[i][i] += lam[i];
    const beta = this.solveLinear(A, B);
    const xq = [
      1,
      Math.log1p(q.qty),
      Math.log(Math.max(q.pages, 4) / 12),
      q.size === 'A4' ? 1 : 0,
      Math.max(0, Math.min(72, q.hours_to_deadline)) / 24,
    ];
    return Math.exp(xq.reduce((z, x, i) => z + x * (beta[i] || 0), 0));
  }

  /**
   * Computes synthetic page-equivalent complexity for non-booklet products when evaluating against
   * historical jobs or product-specific observations.
   */
  private resolveEffectivePagesAndSize(
    spec: OrderSpecification,
    productDef?: ProductDefinition | null
  ): { pages: number | null; size: string | null } {
    const size = (spec.size ?? (spec.attributes?.size as string | undefined) ?? null) as string | null;
    if (!productDef || productDef.id === 'saddle-stitched-booklets') {
      const p = spec.pages ?? (spec.attributes?.pages as number | undefined) ?? null;
      return { pages: p != null ? Number(p) : null, size };
    }
    if (productDef.id === 'flyers-leaflets') {
      const sides = String(spec.attributes?.sides ?? spec.sides ?? 'Double-sided');
      return { pages: /single/i.test(sides) ? 4 : 8, size: size === 'A6' ? 'A5' : size };
    }
    if (productDef.id === 'roller-banners') {
      const isPremium = /premium|teardrop/i.test(String(spec.attributes?.cassette ?? spec.cassette ?? ''));
      return { pages: isPremium ? 24 : 16, size: 'A4' };
    }
    return { pages: Number(spec.pages || 16), size: size || 'A4' };
  }

  hrjPricingV3(
    spec: OrderSpecification,
    historicalJobs: HrjHistoricalJob[],
    now: Date,
    productDef?: ProductDefinition | null
  ): HrjPricingModelResult | null {
    const { pages, size } = this.resolveEffectivePagesAndSize(spec, productDef);
    if (!spec.quantity || !pages || !size || !historicalJobs.length) return null;

    const h = this.routingService.hoursLeft(spec, now) ?? 0;
    const q = {
      qty: Number(spec.quantity),
      pages: Number(pages),
      size,
      hours_to_deadline: Math.max(0, h),
    };

    const rows: HrjComparableJob[] = historicalJobs.map((x) => {
      const distance = this.hrjV2Distance(x, q);
      const similarity = Math.exp(-distance / 1.35);
      const age = Math.max(0, (now.getTime() - new Date(x.paid_at).getTime()) / 86400000);
      const recency = 0.45 + 0.55 * Math.exp(-age / 540);
      const weight = similarity * recency;
      return { ...x, distance, similarity, recency, weight };
    });

    const sw = rows.reduce((z, r) => z + r.weight, 0);
    const sw2 = rows.reduce((z, r) => z + r.weight * r.weight, 0);
    const eff = (sw * sw) / (sw2 + 1e-9);

    const median = this.hrjWeightedQuantile(rows, 0.5);
    const p30 = this.hrjWeightedQuantile(rows, 0.3);
    const p80 = this.hrjWeightedQuantile(rows, 0.8);
    const p90 = this.hrjWeightedQuantile(rows, 0.9);
    const structural = this.hrjStructuralEstimate(rows, q);

    const alpha = Math.min(0.72, Math.max(0.35, eff / 10));
    const expected = alpha * median + (1 - alpha) * structural;
    const target = 0.55 * p30 + 0.45 * expected;
    const protectedAllowance = Math.max(expected + 35, p80);
    const support = eff >= 8 ? 'Strong' : eff >= 4.5 ? 'Moderate' : 'Weak';
    const comparables = rows
      .slice()
      .sort((x, y) => x.distance - y.distance)
      .slice(0, 8);

    return {
      target,
      expected,
      protectedAllowance,
      p80,
      p90,
      median,
      structural,
      effectiveSupport: eff,
      support,
      comparables,
      model: 'HRJ Pricing Model V3 — BO1 + BO2',
    };
  }

  hrjProductionCost(
    spec: OrderSpecification,
    historicalJobs: HrjHistoricalJob[],
    now: Date,
    productDef?: ProductDefinition | null
  ): HrjProductionCostResult {
    const m = this.hrjPricingV3(spec, historicalJobs, now, productDef);
    if (!m) {
      return {
        expected: 0,
        conservative: 0,
        opening: 0,
        targetLow: 0,
        targetHigh: 0,
        autoAccept: 0,
        model: null,
      };
    }
    return {
      expected: m.expected,
      conservative: m.protectedAllowance,
      opening: m.target * 0.82,
      targetLow: m.target * 0.95,
      targetHigh: m.target * 1.05,
      autoAccept: m.protectedAllowance,
      model: m,
    };
  }

  dnpSellingDistance(
    r: DnpSellingObservation,
    q: { qty: number; pages: number; size: string; hours: number }
  ): number {
    const qd = Math.abs(Math.log((r.qty + 5) / (q.qty + 5))) * 1.35;
    const pd = (Math.abs(r.pages - q.pages) / Math.max(q.pages, 12)) * 2.25;
    const sd = r.size2 === q.size ? 0 : 0.85;
    const ud =
      r.urgency_reliable === false
        ? 0
        : Math.abs(this.hrjUrgencyBucket(r.hours_to_deadline) - this.hrjUrgencyBucket(q.hours)) * 0.1;
    return qd + pd + sd + ud;
  }

  dnpSellingPriceV1(
    spec: OrderSpecification,
    protectedFulfilment: number,
    observations: DnpSellingObservation[],
    config: BusinessConfig,
    now: Date,
    productDef?: ProductDefinition | null
  ): DnpSellingPriceModelResult | null {
    const { pages, size } = this.resolveEffectivePagesAndSize(spec, productDef);
    if (!spec.quantity || !pages || !size || !observations.length) return null;

    const h = this.routingService.hoursLeft(spec, now) ?? 0;
    const q = {
      qty: Number(spec.quantity),
      pages: Number(pages),
      size,
      hours: Math.max(0, h),
    };

    const rs: DnpSellingComparable[] = observations.map((x) => {
      const distance = this.dnpSellingDistance(x, q);
      const similarity = Math.exp(-distance / 1.35);
      const age = Math.max(0, (now.getTime() - new Date(x.paid_at).getTime()) / 86400000);
      const recency = 0.45 + 0.55 * Math.exp(-age / 540);
      const weight = similarity * recency;
      return { ...x, distance, weight, recency };
    });

    const wq = (p: number): number => {
      const a = rs.slice().sort((x, y) => x.sell - y.sell);
      const total = a.reduce((z, r) => z + r.weight, 0);
      let c = 0;
      for (const r of a) {
        c += r.weight;
        if (c >= p * total) return r.sell;
      }
      return a[a.length - 1].sell;
    };

    const p25 = wq(0.25);
    const p50 = wq(0.5);
    const p65 = wq(0.65);
    const p75 = wq(0.75);
    const p90 = wq(0.9);

    const sw = rs.reduce((z, r) => z + r.weight, 0);
    const sw2 = rs.reduce((z, r) => z + r.weight * r.weight, 0);
    const eff = (sw * sw) / (sw2 + 1e-9);

    const selectedPercentile = q.hours <= 12 ? 75 : q.hours <= 24 ? 65 : 50;
    const historical = selectedPercentile === 75 ? p75 : selectedPercentile === 65 ? p65 : p50;

    const pRules = productDef?.pricingConfig ?? config.pricingRules;
    const floor = protectedFulfilment * pRules.protectedCostFloorMultiplier;
    const raw = Math.max(historical, floor);
    const step = pRules.quoteRoundingStep || 5;
    const quote = Math.ceil(raw / step) * step;
    const support = eff >= 10 ? 'Strong' : eff >= 6 ? 'Moderate' : 'Weak';
    const comparables = rs
      .slice()
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);

    return {
      p25,
      p50,
      p65,
      p75,
      p90,
      selectedPercentile,
      historical,
      floor,
      quote,
      effectiveSupport: eff,
      support,
      comparables,
      model: 'DNP Selling Price Model V1 — BO1 + BO2',
    };
  }

  deadlineCompressionBarrier(
    hours: number | null,
    basePrice: number | null,
    config: BusinessConfig,
    productDef?: ProductDefinition | null
  ): DeadlineCompressionResult {
    if (hours == null || !Number.isFinite(hours) || basePrice == null) {
      return { premium: 0, total: basePrice, label: 'Base' };
    }
    const pRules = productDef?.pricingConfig ?? config.pricingRules;
    const pts = pRules.deadlineCompressionPoints;
    const maxHour = pts.length ? pts[pts.length - 1][0] : 23;
    if (hours >= maxHour) {
      return { premium: 0, total: basePrice, label: 'Base' };
    }

    let premium = 0;
    if (hours <= 0) {
      premium = pts.length ? pts[0][1] : 1000;
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (hours >= a[0] && hours <= b[0]) {
          const t = (hours - a[0]) / (b[0] - a[0]);
          premium = a[1] + t * (b[1] - a[1]);
          break;
        }
      }
    }

    const compStep = pRules.compressionRoundingStep || 25;
    const quoteStep = pRules.quoteRoundingStep || 5;
    premium = Math.ceil(premium / compStep) * compStep;
    return {
      premium,
      total: Math.ceil((basePrice + premium) / quoteStep) * quoteStep,
      label: premium > 0 ? 'Deadline compression premium' : 'Base',
    };
  }

  standardPrice(
    spec: OrderSpecification,
    route1Rows: Route1BookletPriceRow[],
    config: BusinessConfig,
    productDef?: ProductDefinition | null
  ): StandardPriceResult | null {
    const { pages, size } = this.resolveEffectivePagesAndSize(spec, productDef);
    if (!size || !pages || !spec.quantity) return null;

    const options = route1Rows.filter((r) => r.size === size);
    if (!options.length) return null;

    const pageChoices = [...new Set(options.map((r) => r.pages))].sort((a, b) => a - b);
    const page = pageChoices.find((p) => p >= pages);
    if (page == null) return null;

    const qtyChoices = [...new Set(options.filter((r) => r.pages === page).map((r) => r.quantity))].sort(
      (a, b) => a - b
    );
    const qty = qtyChoices.find((q) => q >= spec.quantity!);
    if (qty == null) return null;

    const row = options.find((r) => r.quantity === qty && r.pages === page);
    if (!row) return null;

    const supplier = row.price;
    const pRules = productDef?.pricingConfig ?? config.pricingRules;
    const deliveryAllowance = pRules.standardDeliveryAllowance;
    const commercial =
      supplier <= 200
        ? 3.5 * supplier
        : supplier <= 500
          ? 700 + 2.75 * (supplier - 200)
          : 1525 + 2 * (supplier - 500);
    const step = pRules.quoteRoundingStep || 5;

    return {
      supplier,
      qty,
      page,
      deliveryAllowance,
      quote: Math.ceil((commercial + deliveryAllowance) / step) * step,
      estimated: qty !== spec.quantity || page !== pages,
    };
  }

  commercialMarkup(hours: number | null, overnight?: boolean): number {
    let pct = 200;
    if (hours !== null && hours <= 24) pct = 225;
    if (hours !== null && hours <= 12) pct = 250;
    if (overnight && hours !== null && hours > 12) pct = Math.max(pct, 225);
    return pct;
  }
}
