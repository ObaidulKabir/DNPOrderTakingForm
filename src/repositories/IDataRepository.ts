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

export interface IDataRepository {
  // Multi-product catalog & capabilities (Relational + JSONB)
  getProducts(): Promise<ProductDefinition[]>;
  getProductById(productId: string): Promise<ProductDefinition | null>;
  upsertProduct(product: ProductDefinition): Promise<ProductDefinition>;

  getSupplierCapabilities(productId?: string): Promise<SupplierProductCapability[]>;
  upsertSupplierCapability(capability: SupplierProductCapability): Promise<SupplierProductCapability>;

  getStandardPriceMatrix(productId?: string): Promise<StandardPriceMatrixRow[]>;
  saveStandardPriceMatrix(productId: string, rows: StandardPriceMatrixRow[]): Promise<void>;

  // Global & product-scoped business config
  getBusinessConfig(): Promise<BusinessConfig>;
  updateBusinessConfig(partial: Partial<BusinessConfig>): Promise<BusinessConfig>;

  // Historical jobs & observations (supports product_id + JSONB attributes)
  getHrjHistoricalJobs(productId?: string): Promise<HrjHistoricalJob[]>;
  saveHrjHistoricalJobs(jobs: HrjHistoricalJob[]): Promise<void>;
  addHrjHistoricalJob(job: HrjHistoricalJob): Promise<HrjHistoricalJob[]>;

  getDnpSellingObservations(productId?: string): Promise<DnpSellingObservation[]>;
  saveDnpSellingObservations(observations: DnpSellingObservation[]): Promise<void>;
  addDnpSellingObservation(obs: DnpSellingObservation): Promise<DnpSellingObservation[]>;

  getRoute1StandardPrices(productId?: string): Promise<Route1BookletPriceRow[]>;
  saveRoute1StandardPrices(rows: Route1BookletPriceRow[]): Promise<void>;

  // Shared logistics & courier distance bands
  getCourierDistanceBands(): Promise<CourierDistanceBand[]>;
  saveCourierDistanceBands(bands: CourierDistanceBand[]): Promise<void>;

  getPostcodeDistances(): Promise<PostcodeDistanceMap>;
  upsertPostcodeDistance(postcode: string, entry: PostcodeDistanceEntry): Promise<PostcodeDistanceMap>;
}
