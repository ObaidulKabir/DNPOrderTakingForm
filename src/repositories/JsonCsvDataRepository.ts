import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BookletSize,
  BusinessConfig,
  CourierDistanceBand,
  DnpSellingObservation,
  HrjHistoricalJob,
  PostcodeDistanceEntry,
  PostcodeDistanceMap,
  ProductDefinition,
  Route1BookletPriceRow,
  StandardPriceMatrixRow,
  SupplierProductCapability,
} from '../domain/types.js';
import { IDataRepository } from './IDataRepository.js';

export class JsonCsvDataRepository implements IDataRepository {
  private readonly dataDir: string;

  constructor(dataDir: string = path.resolve(process.cwd(), 'data')) {
    this.dataDir = dataDir;
  }

  private filePath(name: string): string {
    return path.join(this.dataDir, name);
  }

  async getProducts(): Promise<ProductDefinition[]> {
    const raw = await fs.readFile(this.filePath('products.json'), 'utf8');
    return JSON.parse(raw) as ProductDefinition[];
  }

  async getProductById(productId: string): Promise<ProductDefinition | null> {
    const products = await this.getProducts();
    return products.find((p) => p.id === productId) || null;
  }

  async upsertProduct(product: ProductDefinition): Promise<ProductDefinition> {
    const products = await this.getProducts();
    const idx = products.findIndex((p) => p.id === product.id);
    if (idx >= 0) {
      products[idx] = product;
    } else {
      products.push(product);
    }
    await fs.writeFile(this.filePath('products.json'), JSON.stringify(products, null, 2), 'utf8');
    return product;
  }

  async getSupplierCapabilities(productId?: string): Promise<SupplierProductCapability[]> {
    const raw = await fs.readFile(this.filePath('supplier_capabilities.json'), 'utf8');
    const all = JSON.parse(raw) as SupplierProductCapability[];
    return productId ? all.filter((c) => c.productId === productId) : all;
  }

  async upsertSupplierCapability(capability: SupplierProductCapability): Promise<SupplierProductCapability> {
    const all = await this.getSupplierCapabilities();
    const idx = all.findIndex(
      (c) => c.supplierId === capability.supplierId && c.productId === capability.productId
    );
    if (idx >= 0) {
      all[idx] = capability;
    } else {
      all.push(capability);
    }
    await fs.writeFile(this.filePath('supplier_capabilities.json'), JSON.stringify(all, null, 2), 'utf8');
    return capability;
  }

  async getStandardPriceMatrix(productId?: string): Promise<StandardPriceMatrixRow[]> {
    const rows = await this.getRoute1StandardPrices(productId);
    return rows.map((r, i) => ({
      id: i + 1,
      productId: r.productId || 'saddle-stitched-booklets',
      supplierId: 'route1',
      size: r.size,
      quantity: r.quantity,
      pages: r.pages,
      attributes: r.attributes || { pages: r.pages },
      price: r.price,
    }));
  }

  async saveStandardPriceMatrix(productId: string, rows: StandardPriceMatrixRow[]): Promise<void> {
    const existing = await this.getRoute1StandardPrices();
    const other = existing.filter((r) => (r.productId || 'saddle-stitched-booklets') !== productId);
    const mapped: Route1BookletPriceRow[] = rows.map((r) => ({
      productId,
      size: r.size,
      quantity: r.quantity,
      pages: r.pages ?? Number(r.attributes?.pages ?? 0),
      attributes: r.attributes,
      price: r.price,
    }));
    await this.saveRoute1StandardPrices([...other, ...mapped]);
  }

  async getBusinessConfig(): Promise<BusinessConfig> {
    const raw = await fs.readFile(this.filePath('business_config.json'), 'utf8');
    return JSON.parse(raw) as BusinessConfig;
  }

  async updateBusinessConfig(partial: Partial<BusinessConfig>): Promise<BusinessConfig> {
    const current = await this.getBusinessConfig();
    const merged: BusinessConfig = {
      ...current,
      ...partial,
      pageRange: { ...current.pageRange, ...(partial.pageRange || {}) },
      printedEasy: { ...current.printedEasy, ...(partial.printedEasy || {}) },
      hrjRouting: { ...current.hrjRouting, ...(partial.hrjRouting || {}) },
      rfcModel: { ...current.rfcModel, ...(partial.rfcModel || {}) },
      courierRules: { ...current.courierRules, ...(partial.courierRules || {}) },
      pricingRules: { ...current.pricingRules, ...(partial.pricingRules || {}) },
    };
    await fs.writeFile(this.filePath('business_config.json'), JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  async getHrjHistoricalJobs(productId?: string): Promise<HrjHistoricalJob[]> {
    const raw = await fs.readFile(this.filePath('hrj_pricing_v3.json'), 'utf8');
    const all = JSON.parse(raw) as HrjHistoricalJob[];
    if (!productId) return all;
    return all.filter((j) => (j.product_id || 'saddle-stitched-booklets') === productId);
  }

  async saveHrjHistoricalJobs(jobs: HrjHistoricalJob[]): Promise<void> {
    await fs.writeFile(this.filePath('hrj_pricing_v3.json'), JSON.stringify(jobs, null, 2), 'utf8');
  }

  async addHrjHistoricalJob(job: HrjHistoricalJob): Promise<HrjHistoricalJob[]> {
    const jobs = await this.getHrjHistoricalJobs();
    const updated = [...jobs.filter((j) => j.order_id !== job.order_id), job];
    await this.saveHrjHistoricalJobs(updated);
    return updated;
  }

  async getDnpSellingObservations(productId?: string): Promise<DnpSellingObservation[]> {
    const raw = await fs.readFile(this.filePath('dnp_selling_v1.json'), 'utf8');
    const all = JSON.parse(raw) as DnpSellingObservation[];
    if (!productId) return all;
    return all.filter((o) => (o.product_id || 'saddle-stitched-booklets') === productId);
  }

  async saveDnpSellingObservations(observations: DnpSellingObservation[]): Promise<void> {
    await fs.writeFile(this.filePath('dnp_selling_v1.json'), JSON.stringify(observations, null, 2), 'utf8');
  }

  async addDnpSellingObservation(obs: DnpSellingObservation): Promise<DnpSellingObservation[]> {
    const list = await this.getDnpSellingObservations();
    const updated = [...list.filter((x) => x.id !== obs.id), obs];
    await this.saveDnpSellingObservations(updated);
    return updated;
  }

  async getRoute1StandardPrices(productId?: string): Promise<Route1BookletPriceRow[]> {
    const raw = await fs.readFile(this.filePath('route1_booklet_prices.csv'), 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const rows: Route1BookletPriceRow[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0 && /^size\s*,/i.test(line)) continue;
      const [sizeRaw, qtyRaw, pagesRaw, priceRaw] = line.split(',').map((s) => s.trim());
      if (!sizeRaw || !qtyRaw || !pagesRaw || !priceRaw) continue;
      const pagesNum = Number(pagesRaw);
      rows.push({
        productId: 'saddle-stitched-booklets',
        size: sizeRaw.toUpperCase() as BookletSize,
        quantity: Number(qtyRaw),
        pages: pagesNum,
        attributes: { pages: pagesNum },
        price: Number(priceRaw),
      });
    }
    if (!productId) return rows;
    return rows.filter((r) => (r.productId || 'saddle-stitched-booklets') === productId);
  }

  async saveRoute1StandardPrices(rows: Route1BookletPriceRow[]): Promise<void> {
    const header = 'size,quantity,pages,price';
    const body = rows.map((r) => `${r.size},${r.quantity},${r.pages},${r.price}`).join('\n');
    await fs.writeFile(this.filePath('route1_booklet_prices.csv'), `${header}\n${body}\n`, 'utf8');
  }

  async getCourierDistanceBands(): Promise<CourierDistanceBand[]> {
    const raw = await fs.readFile(this.filePath('courier_distance_bands.json'), 'utf8');
    return JSON.parse(raw) as CourierDistanceBand[];
  }

  async saveCourierDistanceBands(bands: CourierDistanceBand[]): Promise<void> {
    await fs.writeFile(this.filePath('courier_distance_bands.json'), JSON.stringify(bands, null, 2), 'utf8');
  }

  async getPostcodeDistances(): Promise<PostcodeDistanceMap> {
    const raw = await fs.readFile(this.filePath('postcode_distances.json'), 'utf8');
    return JSON.parse(raw) as PostcodeDistanceMap;
  }

  async upsertPostcodeDistance(postcode: string, entry: PostcodeDistanceEntry): Promise<PostcodeDistanceMap> {
    const normalized = postcode.toUpperCase().replace(/\s+/g, '').trim();
    const map = await this.getPostcodeDistances();
    map[normalized] = entry;
    await fs.writeFile(this.filePath('postcode_distances.json'), JSON.stringify(map, null, 2), 'utf8');
    return map;
  }
}
