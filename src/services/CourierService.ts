import {
  BusinessConfig,
  CourierComparisonResult,
  CourierDistanceBand,
  CourierOptionEvaluation,
  DistanceResolution,
  OrderSpecification,
  PostcodeDistanceMap,
  RfcForecast,
} from '../domain/types.js';

export class CourierService {
  normPostcode(postcode: string | null | undefined): string {
    return String(postcode || '')
      .toUpperCase()
      .replace(/\s+/g, '')
      .trim();
  }

  distanceInfo(spec: OrderSpecification, postcodeMap: PostcodeDistanceMap): DistanceResolution {
    if (spec.devMiles != null && Number(spec.devMiles) >= 0) {
      const m = Number(spec.devMiles);
      return {
        miles: m,
        source: 'DEVELOPER TEST OVERRIDE (not derived from postcode)',
        label: `${m.toFixed(1)} mi`,
      };
    }

    const pc = this.normPostcode(spec.postcode);
    if (!pc) {
      return { miles: null, source: 'missing', label: 'Postcode required' };
    }

    const hit = postcodeMap[pc];
    if (hit) {
      return {
        miles: hit.miles,
        source: hit.source || 'historical BO2 route',
        label: `${hit.miles.toFixed(1)} mi`,
      };
    }

    return {
      miles: null,
      source: 'unavailable in standalone prototype',
      label: 'Distance unavailable',
    };
  }

  distanceBand(miles: number | null, bands: CourierDistanceBand[]): CourierDistanceBand | null {
    if (miles == null || !Number.isFinite(miles)) return null;
    const sorted = [...bands].sort((a, b) => a.max - b.max);
    return sorted.find((x) => miles <= x.max) || null;
  }

  estimatedTravelHours(miles: number | null, config: BusinessConfig): number | null {
    if (miles == null || !Number.isFinite(miles)) return null;
    return Math.max(
      config.courierRules.travelMinHours,
      config.courierRules.travelBaseHours + miles / config.courierRules.travelSpeedMph
    );
  }

  isOOHAt(d: Date, config: BusinessConfig): boolean {
    const h = d.getHours() + d.getMinutes() / 60;
    return h >= config.courierRules.oohStartHour || h < config.courierRules.oohEndHour;
  }

  dnpDirectRequiredHours(
    miles: number | null,
    bands: CourierDistanceBand[],
    config: BusinessConfig
  ): number | null {
    if (miles == null || !Number.isFinite(miles)) return null;
    const travel = this.estimatedTravelHours(miles, config);
    if (travel == null) return null;

    const band = this.distanceBand(miles, bands);
    let operationalBuffer: number;
    if (band && typeof band.operationalBufferHours === 'number') {
      operationalBuffer = band.operationalBufferHours;
    } else if (miles <= 3) operationalBuffer = 0.25;
    else if (miles <= 5) operationalBuffer = 0.33;
    else if (miles <= 8) operationalBuffer = 0.42;
    else if (miles <= 12) operationalBuffer = 0.5;
    else if (miles <= 20) operationalBuffer = 0.67;
    else operationalBuffer = 0.83;

    return travel + operationalBuffer;
  }

  courierComparison(
    spec: OrderSpecification,
    rfc: RfcForecast,
    postcodeMap: PostcodeDistanceMap,
    bands: CourierDistanceBand[],
    config: BusinessConfig
  ): CourierComparisonResult {
    const dist = this.distanceInfo(spec, postcodeMap);
    const band = this.distanceBand(dist.miles, bands);
    if (!spec.deadline) {
      return { dist, band, gophr: null, dnp: null, selected: null };
    }

    const dl = new Date(spec.deadline);
    const start = new Date(rfc.start);
    const expectedRfcDate = new Date(rfc.expectedRfc);
    const conservativeRfcDate = new Date(rfc.conservativeRfc);

    const expWin = (dl.getTime() - expectedRfcDate.getTime()) / 3600000;
    const consWin = (dl.getTime() - conservativeRfcDate.getTime()) / 3600000;
    const travel = this.estimatedTravelHours(dist.miles, config);

    const nextDay = dl.toDateString() !== start.toDateString();
    const early = nextDay && dl.getHours() + dl.getMinutes() / 60 < config.courierRules.earlyDeliveryHourCutoff;

    const g: CourierOptionEvaluation = {
      name: 'Gophr',
      eligible: false,
      baseline: null,
      protected: null,
      reason: 'Distance unavailable',
      expWin,
      consWin,
      travel,
    };

    const d: CourierOptionEvaluation = {
      name: 'DNP',
      eligible: false,
      baseline: null,
      protected: null,
      ooh: 0,
      reason: 'Distance unavailable',
      expWin,
      consWin,
      travel,
      overnight: early,
    };

    if (band) {
      const gCompressed = consWin < config.courierRules.gophrCompressedThresholdHours;
      const gVeryTight = consWin < Math.max(1.25, travel || 1);
      g.baseline = band.gophr;
      g.eligible = !early && !gVeryTight;
      g.protected = gCompressed ? Math.max(g.baseline * 2, g.baseline + 15) : g.baseline;
      g.reason = early
        ? 'Cannot collect tonight, hold overnight and deliver next morning'
        : gVeryTight
          ? 'Conservative RFC leaves insufficient Gophr collection/delivery window'
          : gCompressed
            ? 'Eligible, but <6h conservative window: compressed pricing/risk; protected estimate uses ≥2× baseline'
            : 'Eligible with non-compressed historical delivery window';

      d.baseline = band.dnp;
      d.ooh = this.isOOHAt(conservativeRfcDate, config) || early ? config.courierRules.dnpOohSurcharge : 0;
      d.protected = d.baseline + d.ooh;
      d.requiredWindow = this.dnpDirectRequiredHours(dist.miles, bands, config);
      d.eligible = early || (d.requiredWindow != null && consWin >= d.requiredWindow);
      d.reason = early
        ? 'Eligible: DNP can collect late, hold overnight and deliver AM'
        : d.eligible
          ? `Eligible: ${consWin.toFixed(2)}h available after Conservative RFC vs ${d.requiredWindow!.toFixed(2)}h mileage-sensitive DNP requirement`
          : `Not eligible: ${consWin.toFixed(2)}h available after Conservative RFC vs ${d.requiredWindow == null ? 'unknown' : d.requiredWindow.toFixed(2) + 'h'} mileage-sensitive DNP requirement`;
    }

    let selected: CourierOptionEvaluation | null = null;
    if (band) {
      if (early && d.eligible) {
        selected = d;
      } else if (g.eligible && d.eligible) {
        selected =
          consWin < config.courierRules.gophrCompressedThresholdHours
            ? d
            : (g.protected ?? Infinity) <= (d.protected ?? Infinity)
              ? g
              : d;
      } else {
        selected = d.eligible ? d : g.eligible ? g : null;
      }
    }

    return {
      dist,
      band,
      gophr: g,
      dnp: d,
      selected,
      expectedWindow: expWin,
      conservativeWindow: consWin,
      travel,
    };
  }

  deliveryCost(comparison: CourierComparisonResult): {
    baseline: number | null;
    ooh: number;
    total: number | null;
    courier: 'Gophr' | 'DNP' | null;
    comparison: CourierComparisonResult;
  } {
    if (!comparison.selected) {
      return { baseline: null, ooh: 0, total: null, courier: null, comparison };
    }
    return {
      baseline: comparison.selected.baseline,
      ooh: comparison.selected.ooh || 0,
      total: comparison.selected.protected,
      courier: comparison.selected.name,
      comparison,
    };
  }
}
