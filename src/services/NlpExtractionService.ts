import { BusinessConfig, OrderSpecification, ProductDefinition } from '../domain/types.js';

export class NlpExtractionService {
  createInitialSpec(
    config?: Pick<BusinessConfig, 'productName' | 'defaultPaper'>,
    productDef?: ProductDefinition
  ): OrderSpecification {
    const prodId = productDef?.id ?? 'saddle-stitched-booklets';
    const prodName = productDef?.name ?? config?.productName ?? 'Saddle-stitched booklets';
    const defaultPaper = productDef?.defaultPaper ?? config?.defaultPaper ?? 'Silk / Matt';

    const attributes: Record<string, string | number | boolean | null> = {};
    if (productDef) {
      for (const attr of productDef.attributes) {
        attributes[attr.attributeKey] = attr.defaultValue ?? null;
      }
    }

    return {
      productId: prodId,
      product: prodName,
      quantity: null,
      size: null,
      pages: null,
      cover: null,
      inner: null,
      paper: defaultPaper,
      orientation: null,
      attributes,
      artwork: null,
      file: null,
      postcode: null,
      address: null,
      hotel: null,
      hotelName: null,
      deadline: null,
      devMiles: null,
    };
  }

  /**
   * Detects which product from the catalog matches the user's natural language prompt.
   * Defaults to 'saddle-stitched-booklets' when ambiguous or matched.
   */
  detectProductFromText(text: string, products: ProductDefinition[]): ProductDefinition | undefined {
    if (!products.length) return undefined;
    const lower = text.toLowerCase();

    // Check non-default products first for explicit keywords like "flyer", "leaflet", "roller banner", "banner"
    for (const prod of products) {
      if (prod.id === 'saddle-stitched-booklets') continue;
      for (const kw of prod.keywords || []) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) {
          return prod;
        }
      }
    }

    return products.find((p) => p.id === 'saddle-stitched-booklets') || products[0];
  }

  getSpecAttr(spec: OrderSpecification, key: string): unknown {
    if (spec[key] !== undefined && spec[key] !== null && spec[key] !== '') {
      return spec[key];
    }
    if (spec.attributes && spec.attributes[key] !== undefined && spec.attributes[key] !== null && spec.attributes[key] !== '') {
      return spec.attributes[key];
    }
    return null;
  }

  setSpecAttr(spec: OrderSpecification, key: string, value: string | number | boolean | null): void {
    if (!spec.attributes) {
      spec.attributes = {};
    }
    spec.attributes[key] = value;
    if (['size', 'orientation', 'pages', 'cover', 'inner'].includes(key)) {
      (spec as Record<string, unknown>)[key] = value;
    } else {
      spec[key] = value;
    }
  }

  parseDeadline(text: string, now: Date): Date | null {
    const t = text.toLowerCase().trim();
    const d = new Date(now.getTime());

    if (/tomorrow/.test(t)) {
      d.setDate(d.getDate() + 1);
    } else if (/today|tonight/.test(t)) {
      // same day
    } else {
      return null;
    }

    const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
    if (m) {
      let h = Number(m[1]);
      const mi = Number(m[2] || 0);
      if (m[3] === 'pm' && h < 12) h += 12;
      if (m[3] === 'am' && h === 12) h = 0;
      d.setHours(h, mi, 0, 0);
    } else if (/morning/.test(t)) {
      d.setHours(11, 0, 0, 0);
    } else if (/afternoon/.test(t)) {
      d.setHours(16, 0, 0, 0);
    } else if (/evening/.test(t)) {
      d.setHours(19, 0, 0, 0);
    } else {
      return null;
    }

    return d;
  }

  extractFromText(
    text: string,
    currentSpec: OrderSpecification,
    now: Date,
    products?: ProductDefinition[]
  ): OrderSpecification {
    const data: OrderSpecification = structuredClone(currentSpec);
    if (!data.attributes) data.attributes = {};

    // Product detection if products catalog is provided
    if (products && products.length > 0) {
      const detected = this.detectProductFromText(text, products);
      if (detected && (!data.productId || detected.id !== 'saddle-stitched-booklets')) {
        data.productId = detected.id;
        data.product = detected.name;
        data.paper = detected.defaultPaper;
      }
    }

    if (/\blandscape\b/i.test(text)) {
      this.setSpecAttr(data, 'orientation', 'Landscape');
    } else if (/\bportrait\b/i.test(text)) {
      this.setSpecAttr(data, 'orientation', 'Portrait');
    }

    // Banner sizes or standard ISO A-sizes
    const bannerSizeMatch = text.match(/\b(800|850|1000)\s*mm/i);
    if (bannerSizeMatch) {
      this.setSpecAttr(data, 'size', `${bannerSizeMatch[1]}mm × 2000mm`);
    } else {
      const sizeMatch = text.match(/\b(A4|A5|A6)\b/i);
      if (sizeMatch) {
        this.setSpecAttr(data, 'size', sizeMatch[1].toUpperCase());
      }
    }

    // Flyer sides
    if (/\b(?:double[- ]?sided|both\s+sides|2\s*sides)\b/i.test(text)) {
      this.setSpecAttr(data, 'sides', 'Double-sided');
    } else if (/\b(?:single[- ]?sided|one\s+side|1\s*side)\b/i.test(text)) {
      this.setSpecAttr(data, 'sides', 'Single-sided');
    }

    // Roller banner cassette base
    if (/\b(?:premium|teardrop|luxury)\b/i.test(text) && data.productId === 'roller-banners') {
      this.setSpecAttr(data, 'cassette', 'Premium Teardrop Base');
    } else if (/\bstandard\s+base\b/i.test(text) && data.productId === 'roller-banners') {
      this.setSpecAttr(data, 'cassette', 'Standard Base');
    }

    const pagesMatch = text.match(/(\d{1,3})\s*(?:page|pages|pp)\b/i);
    if (pagesMatch) {
      this.setSpecAttr(data, 'pages', Number(pagesMatch[1]));
    }

    // Quantity: "100 copies", "100 booklets", "250 A5 flyers", "4 roller banners", or "100 x A4"
    let qtyMatch = text.match(
      /\b(\d{1,5})\s*(?:[x×]\s*)?(?:A[456]\s+|(?:800|850|1000)\s*mm\s+|roller\s+|pull[- ]?up\s+|flat\s+|saddle[- ]?stitched\s+)*(?:copies|copy|booklets|booklet|brochures|brochure|flyers|flyer|leaflets|leaflet|banners|banner|stands|stand)\b/i
    );
    if (!qtyMatch) {
      qtyMatch = text.match(/\b(\d{1,5})\s*[x×]\s*(?=A[456]\b|800|850|1000)/i);
    }
    if (qtyMatch) {
      data.quantity = Number(qtyMatch[1]);
    }

    // Stock: understand "350 gsm cover, 170 gsm inner" or single stock "170gsm silk" for flyers
    const coverMatch = text.match(/\b(\d{2,3})\s*gsm\s*(?:silk\s*)?(?:cover|covers)\b/i);
    const innerMatch = text.match(/\b(\d{2,3})\s*gsm\s*(?:silk\s*)?(?:inner|inners|inside|inner\s*pages?)\b/i);
    if (coverMatch) this.setSpecAttr(data, 'cover', `${coverMatch[1]}gsm Silk`);
    if (innerMatch) this.setSpecAttr(data, 'inner', `${innerMatch[1]}gsm Silk`);

    if (!coverMatch && !innerMatch) {
      const singleStockMatch = text.match(/\b(130|150|170|250|350)\s*gsm\b/i);
      if (singleStockMatch) {
        this.setSpecAttr(data, 'stock', `${singleStockMatch[1]}gsm Silk`);
      }
    }

    // Artwork readiness.
    if (
      /\bartwork\b[^.!?]{0,30}\b(?:is\s+)?(?:print[- ]?ready|ready|supplied|complete|finished)\b/i.test(text) ||
      /\b(?:print[- ]?ready|ready)\s+artwork\b/i.test(text)
    ) {
      data.artwork = 'Ready';
    }
    if (/\bartwork\b[^.!?]{0,30}\b(?:not\s+ready|isn['’]?t\s+ready|not\s+finished)\b/i.test(text)) {
      data.artwork = 'Not ready';
    }

    // UK postcode.
    const pcMatch = text.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i);
    if (pcMatch && pcMatch.index !== undefined) {
      data.postcode = pcMatch[0]
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/([A-Z\d])\s*(\d[A-Z]{2})$/, '$1 $2');

      const beforePc = text.slice(0, pcMatch.index);
      const explicitAddrMatch = beforePc.match(
        /(?:deliver(?:y)?\s+(?:to|at)|delivery\s+address\s+(?:is|:)?|send\s+(?:to|at)|ship\s+(?:to|at))\s+(.+?)\s*,?\s*$/i
      );
      if (explicitAddrMatch) {
        const cleaned = explicitAddrMatch[1].trim().replace(/[,.\s]+$/, '');
        if (cleaned) data.address = cleaned;
      } else {
        const parts = beforePc
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        const candidate = parts.length ? parts[parts.length - 1] : '';
        const looksAddress =
          /\b\d+[A-Za-z]?\b/.test(candidate) ||
          /\b(?:house|road|rd|street|st|avenue|ave|lane|ln|close|court|way|drive|dr|place|pl|building|tower|flat|unit)\b/i.test(
            candidate
          );
        const looksPrintSpec =
          /\b(?:gsm|pages?|pp|copies|copy|booklets?|flyers?|leaflets?|banners?|cover|inner|A4|A5|A6)\b/i.test(
            candidate
          );
        if (candidate && looksAddress && !looksPrintSpec) {
          data.address = candidate;
        }
      }
    }

    // Staging mileage: "3.4 miles away", "3.4 mi", "mileage 3.4".
    let milesMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(?:miles?|mi)\b/i);
    if (!milesMatch) {
      milesMatch = text.match(/\bmileage\s*(?:is|=|:)?\s*(\d+(?:\.\d+)?)/i);
    }
    if (milesMatch) {
      data.devMiles = Number(milesMatch[1]);
    }

    const parsedDeadline = this.parseDeadline(text, now);
    if (parsedDeadline) {
      data.deadline = parsedDeadline.toISOString();
    }

    return data;
  }
}
