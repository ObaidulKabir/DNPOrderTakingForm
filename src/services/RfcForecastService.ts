import {
  BusinessConfig,
  OrderSpecification,
  ProductDefinition,
  RfcForecast,
} from '../domain/types.js';

export class RfcForecastService {
  liveHrjRfc(
    spec: OrderSpecification,
    config: BusinessConfig,
    now: Date,
    productDef?: ProductDefinition | null
  ): RfcForecast {
    const start = new Date(now.getTime());
    const rfcCfg = productDef?.rfcModelConfig ?? config.rfcModel;

    const q = Number(spec.quantity || 25);
    const pages = Number(spec.pages || spec.attributes?.pages || 24);
    const size = String(spec.size || spec.attributes?.size || 'A5');

    let expected = rfcCfg.baseExpectedHours;
    if (!productDef || productDef.id === 'saddle-stitched-booklets') {
      expected += Math.max(-0.7, Math.min(2.2, (pages - 24) * 0.055));
      expected += Math.max(-0.5, Math.min(1.6, (q - 25) * 0.018));
    } else if (productDef.id === 'flyers-leaflets') {
      expected += Math.max(-0.3, Math.min(1.5, (q - 250) * 0.0005));
    } else if (productDef.id === 'roller-banners') {
      expected += Math.max(-0.2, Math.min(2.0, (q - 2) * 0.22));
    }

    if (size === 'A4') {
      expected += rfcCfg.a4AdderHours;
    }
    expected = Math.max(rfcCfg.minExpectedHours, expected);

    let conservative = Math.max(expected + 2.0, expected * 1.45);
    const w = rfcCfg.p80BlendWeight;
    conservative = (1 - w) * conservative + w * rfcCfg.p80AnchorHours;

    const expectedRfc = new Date(start.getTime() + expected * 3600000);
    const conservativeRfc = new Date(start.getTime() + conservative * 3600000);
    const confidence =
      q <= 50 && pages >= 8 && pages <= 40 && (size === 'A4' || size === 'A5') ? 'Medium' : 'Low';

    return {
      start: start.toISOString(),
      expectedHours: expected,
      conservativeHours: conservative,
      expectedRfc: expectedRfc.toISOString(),
      conservativeRfc: conservativeRfc.toISOString(),
      confidence,
    };
  }
}
