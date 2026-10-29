import {
  BusinessConfig,
  OrderSpecification,
  QuantityLimitTier,
  SupplierProductCapability,
  SupplierRouteEvaluation,
} from '../domain/types.js';

export class SupplierRoutingService {
  hoursLeft(spec: OrderSpecification, now: Date): number | null {
    if (!spec.deadline) return null;
    const dl = new Date(spec.deadline);
    if (Number.isNaN(dl.getTime())) return null;
    return (dl.getTime() - now.getTime()) / 3600000;
  }

  private resolveQuantityTiers(
    config: BusinessConfig,
    capabilities?: SupplierProductCapability[]
  ): { tiers: QuantityLimitTier[]; defaultChoices: number[] } {
    const hrjCap = capabilities?.find((c) => c.supplierId === 'hrj-media' && c.quantityLimitsByHours?.length);
    if (hrjCap) {
      return {
        tiers: hrjCap.quantityLimitsByHours,
        defaultChoices: hrjCap.defaultQuantityChoices.length
          ? hrjCap.defaultQuantityChoices
          : config.defaultQuantityChoices,
      };
    }
    return {
      tiers: config.quantityLimitsByHours,
      defaultChoices: config.defaultQuantityChoices,
    };
  }

  maxQtyForHours(
    hours: number | null,
    config: BusinessConfig,
    capabilities?: SupplierProductCapability[]
  ): number {
    if (hours === null || !Number.isFinite(hours)) return Infinity;
    const { tiers } = this.resolveQuantityTiers(config, capabilities);
    const sortedTiers = [...tiers].sort((a, b) => a.maxHours - b.maxHours);
    for (const tier of sortedTiers) {
      if (hours <= tier.maxHours) return tier.maxQty;
    }
    return Infinity;
  }

  getQuantityChoicesForHours(
    hours: number | null,
    config: BusinessConfig,
    capabilities?: SupplierProductCapability[]
  ): number[] {
    const { tiers, defaultChoices } = this.resolveQuantityTiers(config, capabilities);
    if (hours === null || !Number.isFinite(hours)) return defaultChoices;
    const sortedTiers = [...tiers].sort((a, b) => a.maxHours - b.maxHours);
    for (const tier of sortedTiers) {
      if (hours <= tier.maxHours) return tier.choices;
    }
    return defaultChoices;
  }

  isValidQuantity(
    spec: OrderSpecification,
    config: BusinessConfig,
    now: Date,
    capabilities?: SupplierProductCapability[]
  ): boolean {
    const h = this.hoursLeft(spec, now);
    if (!spec.quantity || h === null) return true;
    return spec.quantity <= this.maxQtyForHours(h, config, capabilities);
  }

  /**
   * Checks whether the current specification violates any supplier machine/capability exclusion
   * (e.g., A4 Landscape under 72h for HRJ booklets).
   */
  checkSupplierExclusions(
    spec: OrderSpecification,
    hoursLeft: number | null,
    capabilities?: SupplierProductCapability[]
  ): string | null {
    if (capabilities && capabilities.length > 0) {
      const hrjCap = capabilities.find((c) => c.supplierId === 'hrj-media');
      if (hrjCap) {
        for (const excl of hrjCap.excludedCombinations || []) {
          if (excl.maxHours != null && (hoursLeft == null || hoursLeft >= excl.maxHours)) {
            continue;
          }
          const allMatch = Object.entries(excl.attributes).every(([k, val]) => {
            const actual = spec[k] ?? spec.attributes?.[k];
            return String(actual) === String(val);
          });
          if (allMatch) {
            return excl.reason;
          }
        }
      }
    }

    // Fallback default booklet rule
    if (
      (spec.productId === 'saddle-stitched-booklets' || !spec.productId) &&
      spec.size === 'A4' &&
      spec.orientation === 'Landscape' &&
      hoursLeft !== null &&
      hoursLeft < 72
    ) {
      return 'HRJ excluded: A4 Landscape cannot be produced on its machine. Manual alternative supplier confirmation required.';
    }

    return null;
  }

  private isWeekend(d: Date): boolean {
    const day = d.getDay();
    return day === 0 || day === 6;
  }

  peRoute(spec: OrderSpecification, config: BusinessConfig, now: Date): SupplierRouteEvaluation {
    const dl = spec.deadline ? new Date(spec.deadline) : new Date(now.getTime());
    const mins = now.getHours() * 60 + now.getMinutes();
    const day = now.getDay();

    const customerCutoff = config.printedEasy.customerCutoffMinutes; // 15:30 = 930
    const todayEligible = day >= 1 && day <= 5 && mins <= customerCutoff;

    const standardDeliveryDay = new Date(now.getTime());
    standardDeliveryDay.setDate(now.getDate() + 1);
    while (this.isWeekend(standardDeliveryDay)) {
      standardDeliveryDay.setDate(standardDeliveryDay.getDate() + 1);
    }
    standardDeliveryDay.setHours(config.printedEasy.standardDeliveryHour, 0, 0, 0);

    const standardFeasible = todayEligible && dl >= standardDeliveryDay;

    const ownCollectReady = new Date(now.getTime());
    const readyHour = Math.floor(config.printedEasy.ownCollectReadyHour);
    const readyMinute = Math.round((config.printedEasy.ownCollectReadyHour - readyHour) * 60);
    ownCollectReady.setHours(readyHour, readyMinute, 0, 0);

    const ownCourierFeasible =
      todayEligible &&
      dl.toDateString() === now.toDateString() &&
      dl >= new Date(ownCollectReady.getTime() + config.printedEasy.ownCourierBufferMinutes * 60000);

    const eligible = standardFeasible || ownCourierFeasible;
    const route = ownCourierFeasible
      ? 'PE production → own courier collection'
      : 'PE standard production/delivery';

    let reason: string;
    if (!todayEligible) {
      reason =
        day === 0 || day === 6
          ? 'PE ordering route closed for weekend staging rule'
          : 'Customer payment cutoff 15:30 has passed';
    } else if (standardFeasible) {
      reason = 'PE cutoff and delivery calendar fit deadline';
    } else if (ownCourierFeasible) {
      reason = 'PE cutoff fits + same-evening collection route fits';
    } else {
      reason = 'PE delivery timing does not fit deadline';
    }

    return {
      supplier: 'PrintedEasy',
      eligible,
      route,
      reason,
      cutoff: 'Customer pay by 15:30 · supplier order by 16:00',
      confidence: 'High (rule-based demo)',
    };
  }

  hrjRoute(spec: OrderSpecification, config: BusinessConfig, now: Date): SupplierRouteEvaluation {
    const dl = spec.deadline ? new Date(spec.deadline) : new Date(now.getTime());
    const h = this.hoursLeft(spec, now) ?? 0;

    const tomorrow = new Date(now.getTime());
    tomorrow.setDate(now.getDate() + 1);
    const dlHour = dl.getHours() + dl.getMinutes() / 60;
    const earlyTomorrow =
      dl.toDateString() === tomorrow.toDateString() && dlHour < config.hrjRouting.safeNextDayDeliveryHour;

    if (earlyTomorrow) {
      return {
        supplier: 'HRJ Media',
        eligible: h >= config.hrjRouting.minHoursEarlyTomorrow,
        route: 'HRJ production → collect tonight → held overnight → morning courier delivery',
        reason:
          'Deadline is before the safe ~13:00 next-day HRJ collection/delivery window; overnight collection is required',
        cutoff: 'Flexible / manual production window',
        confidence: h >= 10 ? 'Medium–high' : 'Medium',
        overnight: true,
      };
    }

    return {
      supplier: 'HRJ Media',
      eligible: h >= config.hrjRouting.minHoursDirect,
      route: 'HRJ production → courier collection → direct delivery',
      reason: 'HRJ 7-day availability and deadline is within a safe post-opening delivery window',
      cutoff: 'Flexible / manual production window',
      confidence: h >= 8 ? 'High' : 'Medium',
      overnight: false,
    };
  }

  selectSupplier(
    spec: OrderSpecification,
    config: BusinessConfig,
    now: Date
  ): { selected: SupplierRouteEvaluation | null; alternatives: SupplierRouteEvaluation[] } {
    const pe = this.peRoute(spec, config, now);
    const hrj = this.hrjRoute(spec, config, now);
    if (pe.eligible) return { selected: pe, alternatives: [hrj] };
    if (hrj.eligible) return { selected: hrj, alternatives: [pe] };
    return { selected: null, alternatives: [pe, hrj] };
  }
}
