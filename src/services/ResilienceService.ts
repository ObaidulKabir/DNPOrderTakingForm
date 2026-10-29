import {
  BusinessConfig,
  CourierComparisonResult,
  LiveResilienceResult,
  OrderSpecification,
  RfcForecast,
  SupplierProductCapability,
  TrafficLightStatus,
} from '../domain/types.js';
import { SupplierRoutingService } from './SupplierRoutingService.js';

export class ResilienceService {
  constructor(private readonly routingService: SupplierRoutingService) {}

  liveResilience(
    spec: OrderSpecification,
    rfc: RfcForecast,
    courierComp: CourierComparisonResult
  ): LiveResilienceResult {
    if (!spec.deadline) {
      return {
        status: 'WAITING',
        productionStatus: 'WAITING',
        deliveryStatus: 'WAITING',
        auto: false,
        reasons: ['Exact customer deadline has not yet been collected.'],
      };
    }

    const dl = new Date(spec.deadline);
    const expectedRfcDate = new Date(rfc.expectedRfc);
    const conservativeRfcDate = new Date(rfc.conservativeRfc);

    const expBuf = (dl.getTime() - expectedRfcDate.getTime()) / 3600000;
    const consBuf = (dl.getTime() - conservativeRfcDate.getTime()) / 3600000;

    let productionStatus: TrafficLightStatus = 'AMBER';
    let productionReason = '';
    if (expBuf <= 0) {
      productionStatus = 'RED';
      productionReason = 'Expected RFC is after the customer deadline.';
    } else if (consBuf < 0) {
      productionStatus = 'AMBER';
      productionReason =
        'Expected RFC fits, but Conservative RFC is after the customer deadline: supplier prioritisation / human confirmation may be required.';
    } else {
      productionStatus = 'GREEN';
      productionReason = `Conservative RFC is before the customer deadline by ${consBuf.toFixed(2)}h; post-RFC sufficiency is assessed separately against the selected courier and mileage.`;
    }

    let deliveryStatus: TrafficLightStatus = 'AMBER';
    let deliveryReason = '';
    let route = 'Courier route pending';
    let recovery: number | null = null;

    if (courierComp.dist.miles == null) {
      deliveryStatus = 'AMBER';
      deliveryReason =
        'Destination mileage is not yet verified, so courier feasibility and price cannot be safely finalised.';
    } else if (!courierComp.selected) {
      deliveryStatus = expBuf < (courierComp.travel || 1) ? 'RED' : 'AMBER';
      deliveryReason = 'No courier passes the current conservative RFC → deadline window.';
    } else {
      route = `HRJ → ${courierComp.selected.name}${
        courierComp.selected.overnight
          ? ' late collection → overnight hold → AM delivery'
          : ' direct delivery'
      }`;
      recovery = consBuf - (courierComp.travel || 1);

      if (expBuf < (courierComp.travel || 1)) {
        deliveryStatus = 'RED';
        deliveryReason = 'Expected RFC leaves less time than the planning collection/travel allowance.';
      } else if (courierComp.selected.overnight) {
        deliveryStatus = consBuf >= 1.5 ? 'GREEN' : 'AMBER';
        deliveryReason =
          deliveryStatus === 'GREEN'
            ? 'DNP overnight-hold capability protects the next-morning route.'
            : 'Overnight capability helps, but the morning runway is narrow.';
      } else if (courierComp.selected.name === 'DNP') {
        const req =
          courierComp.selected.requiredWindow != null
            ? courierComp.selected.requiredWindow
            : courierComp.travel || 0.75;
        if (consBuf >= req) {
          deliveryStatus = 'GREEN';
          deliveryReason = `DNP direct route is feasible at Conservative RFC: ${consBuf.toFixed(2)}h available vs ${req.toFixed(2)}h required for ${courierComp.dist.miles.toFixed(1)} miles.`;
        } else {
          deliveryStatus = expBuf >= req ? 'AMBER' : 'RED';
          deliveryReason = `DNP route needs about ${req.toFixed(2)}h after RFC for ${courierComp.dist.miles.toFixed(1)} miles; Conservative RFC leaves ${consBuf.toFixed(2)}h.`;
        }
      } else if (recovery >= 2) {
        deliveryStatus = 'GREEN';
        deliveryReason =
          'Third-party courier remains feasible at Conservative RFC with at least ~2h recovery after planning travel.';
      } else {
        deliveryStatus = 'AMBER';
        deliveryReason =
          'Third-party courier is feasible on expected timing, but conservative recovery capacity is limited.';
      }
    }

    const rank: Record<TrafficLightStatus, number> = { WAITING: 0, GREEN: 1, AMBER: 2, RED: 3 };
    const status = rank[productionStatus] >= rank[deliveryStatus] ? productionStatus : deliveryStatus;
    const reasons = [
      `Production — ${productionStatus}: ${productionReason}`,
      `Delivery — ${deliveryStatus}: ${deliveryReason}`,
    ];

    return {
      status,
      productionStatus,
      deliveryStatus,
      auto: status === 'GREEN',
      rfc,
      route,
      resilience: deliveryStatus === 'GREEN' ? 'High' : deliveryStatus === 'RED' ? 'Low' : 'Medium',
      expectedBuffer: expBuf,
      conservativeBuffer: consBuf,
      recovery,
      reasons,
      couriers: courierComp,
      productionReason,
      deliveryReason,
    };
  }

  feasibility(
    spec: OrderSpecification,
    config: BusinessConfig,
    live: LiveResilienceResult,
    now: Date,
    capabilities?: SupplierProductCapability[]
  ): { ok: boolean; why: string; live: LiveResilienceResult } {
    const h = this.routingService.hoursLeft(spec, now);
    const q = spec.quantity;

    if (h !== null && h <= 0) {
      return { ok: false, why: 'Deadline has passed', live };
    }
    if (q && h !== null && q > this.routingService.maxQtyForHours(h, config, capabilities)) {
      return { ok: false, why: 'Quantity exceeds validated window', live };
    }
    if (live.status === 'RED') {
      return { ok: false, why: 'Live RFC/route engine: RED — human intervention required', live };
    }
    if (live.status === 'AMBER') {
      return { ok: false, why: 'Live RFC/route engine: AMBER — human review required before payment', live };
    }
    if (live.status === 'WAITING') {
      return { ok: false, why: 'Exact deadline still required', live };
    }
    return { ok: true, why: 'Live RFC/route engine: GREEN', live };
  }
}
