import {
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

export interface InMemorySeedData {
  products: ProductDefinition[];
  supplierCapabilities: SupplierProductCapability[];
  businessConfig: BusinessConfig;
  hrjJobs: HrjHistoricalJob[];
  dnpSellingObservations: DnpSellingObservation[];
  route1Prices: Route1BookletPriceRow[];
  courierBands: CourierDistanceBand[];
  postcodeDistances: PostcodeDistanceMap;
}

export class InMemoryDataRepository implements IDataRepository {
  private products: ProductDefinition[];
  private supplierCapabilities: SupplierProductCapability[];
  private businessConfig: BusinessConfig;
  private hrjJobs: HrjHistoricalJob[];
  private dnpSellingObservations: DnpSellingObservation[];
  private route1Prices: Route1BookletPriceRow[];
  private courierBands: CourierDistanceBand[];
  private postcodeDistances: PostcodeDistanceMap;

  constructor(seed: InMemorySeedData) {
    this.products = structuredClone(seed.products);
    this.supplierCapabilities = structuredClone(seed.supplierCapabilities);
    this.businessConfig = structuredClone(seed.businessConfig);
    this.hrjJobs = structuredClone(seed.hrjJobs);
    this.dnpSellingObservations = structuredClone(seed.dnpSellingObservations);
    this.route1Prices = structuredClone(seed.route1Prices);
    this.courierBands = structuredClone(seed.courierBands);
    this.postcodeDistances = structuredClone(seed.postcodeDistances);
  }

  static async fromRepository(source: IDataRepository): Promise<InMemoryDataRepository> {
    const [
      products,
      supplierCapabilities,
      businessConfig,
      hrjJobs,
      dnpSellingObservations,
      route1Prices,
      courierBands,
      postcodeDistances,
    ] = await Promise.all([
      source.getProducts(),
      source.getSupplierCapabilities(),
      source.getBusinessConfig(),
      source.getHrjHistoricalJobs(),
      source.getDnpSellingObservations(),
      source.getRoute1StandardPrices(),
      source.getCourierDistanceBands(),
      source.getPostcodeDistances(),
    ]);
    return new InMemoryDataRepository({
      products,
      supplierCapabilities,
      businessConfig,
      hrjJobs,
      dnpSellingObservations,
      route1Prices,
      courierBands,
      postcodeDistances,
    });
  }

  async getProducts(): Promise<ProductDefinition[]> {
    return structuredClone(this.products);
  }

  async getProductById(productId: string): Promise<ProductDefinition | null> {
    const hit = this.products.find((p) => p.id === productId);
    return hit ? structuredClone(hit) : null;
  }

  async upsertProduct(product: ProductDefinition): Promise<ProductDefinition> {
    const idx = this.products.findIndex((p) => p.id === product.id);
    if (idx >= 0) {
      this.products[idx] = structuredClone(product);
    } else {
      this.products.push(structuredClone(product));
    }
    return structuredClone(product);
  }

  async getSupplierCapabilities(productId?: string): Promise<SupplierProductCapability[]> {
    const list = productId
      ? this.supplierCapabilities.filter((c) => c.productId === productId)
      : this.supplierCapabilities;
    return structuredClone(list);
  }

  async upsertSupplierCapability(capability: SupplierProductCapability): Promise<SupplierProductCapability> {
    const idx = this.supplierCapabilities.findIndex(
      (c) => c.supplierId === capability.supplierId && c.productId === capability.productId
    );
    if (idx >= 0) {
      this.supplierCapabilities[idx] = structuredClone(capability);
    } else {
      this.supplierCapabilities.push(structuredClone(capability));
    }
    return structuredClone(capability);
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
    const other = this.route1Prices.filter((r) => (r.productId || 'saddle-stitched-booklets') !== productId);
    const mapped: Route1BookletPriceRow[] = rows.map((r) => ({
      productId,
      size: r.size,
      quantity: r.quantity,
      pages: r.pages ?? Number(r.attributes?.pages ?? 0),
      attributes: r.attributes,
      price: r.price,
    }));
    this.route1Prices = structuredClone([...other, ...mapped]);
  }

  async getBusinessConfig(): Promise<BusinessConfig> {
    return structuredClone(this.businessConfig);
  }

  async updateBusinessConfig(partial: Partial<BusinessConfig>): Promise<BusinessConfig> {
    this.businessConfig = {
      ...this.businessConfig,
      ...partial,
      pageRange: { ...this.businessConfig.pageRange, ...(partial.pageRange || {}) },
      printedEasy: { ...this.businessConfig.printedEasy, ...(partial.printedEasy || {}) },
      hrjRouting: { ...this.businessConfig.hrjRouting, ...(partial.hrjRouting || {}) },
      rfcModel: { ...this.businessConfig.rfcModel, ...(partial.rfcModel || {}) },
      courierRules: { ...this.businessConfig.courierRules, ...(partial.courierRules || {}) },
      pricingRules: { ...this.businessConfig.pricingRules, ...(partial.pricingRules || {}) },
    };
    return this.getBusinessConfig();
  }

  async getHrjHistoricalJobs(productId?: string): Promise<HrjHistoricalJob[]> {
    const list = productId
      ? this.hrjJobs.filter((j) => (j.product_id || 'saddle-stitched-booklets') === productId)
      : this.hrjJobs;
    return structuredClone(list);
  }

  async saveHrjHistoricalJobs(jobs: HrjHistoricalJob[]): Promise<void> {
    this.hrjJobs = structuredClone(jobs);
  }

  async addHrjHistoricalJob(job: HrjHistoricalJob): Promise<HrjHistoricalJob[]> {
    this.hrjJobs = [...this.hrjJobs.filter((j) => j.order_id !== job.order_id), structuredClone(job)];
    return this.getHrjHistoricalJobs();
  }

  async getDnpSellingObservations(productId?: string): Promise<DnpSellingObservation[]> {
    const list = productId
      ? this.dnpSellingObservations.filter((o) => (o.product_id || 'saddle-stitched-booklets') === productId)
      : this.dnpSellingObservations;
    return structuredClone(list);
  }

  async saveDnpSellingObservations(observations: DnpSellingObservation[]): Promise<void> {
    this.dnpSellingObservations = structuredClone(observations);
  }

  async addDnpSellingObservation(obs: DnpSellingObservation): Promise<DnpSellingObservation[]> {
    this.dnpSellingObservations = [
      ...this.dnpSellingObservations.filter((x) => x.id !== obs.id),
      structuredClone(obs),
    ];
    return this.getDnpSellingObservations();
  }

  async getRoute1StandardPrices(productId?: string): Promise<Route1BookletPriceRow[]> {
    const list = productId
      ? this.route1Prices.filter((r) => (r.productId || 'saddle-stitched-booklets') === productId)
      : this.route1Prices;
    return structuredClone(list);
  }

  async saveRoute1StandardPrices(rows: Route1BookletPriceRow[]): Promise<void> {
    this.route1Prices = structuredClone(rows);
  }

  async getCourierDistanceBands(): Promise<CourierDistanceBand[]> {
    return structuredClone(this.courierBands);
  }

  async saveCourierDistanceBands(bands: CourierDistanceBand[]): Promise<void> {
    this.courierBands = structuredClone(bands);
  }

  async getPostcodeDistances(): Promise<PostcodeDistanceMap> {
    return structuredClone(this.postcodeDistances);
  }

  async upsertPostcodeDistance(postcode: string, entry: PostcodeDistanceEntry): Promise<PostcodeDistanceMap> {
    const normalized = postcode.toUpperCase().replace(/\s+/g, '').trim();
    this.postcodeDistances[normalized] = structuredClone(entry);
    return this.getPostcodeDistances();
  }
}
