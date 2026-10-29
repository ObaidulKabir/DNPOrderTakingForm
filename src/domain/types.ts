export type BookletSize = 'A4' | 'A5';
export type BookletOrientation = 'Portrait' | 'Landscape';
export type ArtworkStatus = 'Ready' | 'Not ready';
export type TrafficLightStatus = 'WAITING' | 'GREEN' | 'AMBER' | 'RED';

// ---- MULTI-PRODUCT CATALOG & DYNAMIC ATTRIBUTE DEFINITIONS ----

export type AttributeInputType = 'select' | 'number' | 'text';

export interface ProductAttributeValidationRules {
  min?: number;
  max?: number;
  multipleOf?: number;
  allowedValues?: string[];
  errorMessage?: string;
}

export interface ProductAttributeQuickChoice {
  label: string;
  value: string | number;
}

export interface ProductAttributeDefinition {
  id?: number;
  productId: string;
  attributeKey: string;
  label: string;
  inputType: AttributeInputType;
  wideInput?: boolean;
  sortOrder: number;
  required: boolean;
  defaultValue?: string | number | null;
  placeholder?: string;
  suffix?: string;
  questionPrompt: string;
  validationRules: ProductAttributeValidationRules;
  quickChoices: ProductAttributeQuickChoice[];
  compositeGroup?: string; // e.g., 'stock' groups 'cover' + 'inner'
}

export interface ProductRfcModelConfig {
  baseExpectedHours: number;
  minExpectedHours: number;
  a4AdderHours: number;
  p80AnchorHours: number;
  p80BlendWeight: number;
  primaryDriverKey?: string; // e.g., 'pages' for booklets
  primaryDriverBaseline?: number;
  primaryDriverSlope?: number;
}

export interface ProductPricingConfig {
  standardThresholdHours: number;
  standardDeliveryAllowance: number;
  protectedCostFloorMultiplier: number;
  quoteRoundingStep: number;
  compressionRoundingStep: number;
  deadlineCompressionPoints: [number, number][];
}

export interface ProductStockRecommendation {
  promptHtml: string;
  recommendedValues: Record<string, string>;
  customPromptHtml: string;
}

export interface ProductDefinition {
  id: string; // e.g. 'saddle-stitched-booklets', 'flyers-leaflets', 'roller-banners'
  name: string; // e.g. 'Saddle-stitched booklets'
  singularName: string; // e.g. 'Saddle-stitched booklet'
  category: string;
  vatRate: number; // 0 for booklets/leaflets, 0.20 for banners/posters
  active: boolean;
  defaultPaper: string;
  keywords: string[]; // NLP detection keywords for this product
  attributes: ProductAttributeDefinition[];
  stockRecommendation?: ProductStockRecommendation | null;
  rfcModelConfig: ProductRfcModelConfig;
  pricingConfig: ProductPricingConfig;
}

export interface SupplierExcludedCombination {
  attributes: Record<string, string | number>;
  maxHours?: number;
  reason: string;
}

export interface SupplierProductCapability {
  supplierId: string;
  supplierName: string;
  productId: string;
  supported: boolean;
  excludedCombinations: SupplierExcludedCombination[];
  quantityLimitsByHours: QuantityLimitTier[];
  defaultQuantityChoices: number[];
}

export interface StandardPriceMatrixRow {
  id?: number;
  productId: string;
  supplierId: string;
  size: string;
  quantity: number;
  pages?: number | null;
  attributes: Record<string, string | number>; // Stored as JSONB in PostgreSQL
  price: number;
}

// ---- ORDER SPECIFICATION (MULTI-PRODUCT + JSONB ATTRIBUTES) ----

export interface OrderSpecification {
  productId?: string;
  product: string;
  quantity: number | null;
  size: string | null;
  pages: number | null;
  cover: string | null;
  inner: string | null;
  paper: string;
  orientation: string | null;
  // Dynamic JSONB-backed attributes for any product (e.g. sides, finish, width, stock, etc.)
  attributes?: Record<string, string | number | boolean | null>;
  artwork: ArtworkStatus | null;
  file: string | null;
  postcode: string | null;
  address: string | null;
  hotel: boolean | null;
  hotelName: string | null;
  deadline: string | null; // ISO 8601 string or datetime string
  devMiles: number | null;
  [key: string]: unknown;
}

export interface HrjHistoricalJob {
  order_id: string;
  product_id?: string;
  vendor_due: number;
  qty: number;
  size2: string;
  pages: number;
  attributes?: Record<string, string | number>; // JSONB in PostgreSQL
  hours_to_deadline: number | null;
  paid_at: string;
  source: string;
  urgency_reliable: boolean;
}

export interface DnpSellingObservation {
  id: string;
  product_id?: string;
  source: string;
  qty: number;
  size2: string;
  pages: number;
  attributes?: Record<string, string | number>; // JSONB in PostgreSQL
  sell: number;
  vendor_due: number;
  paid_at: string;
  hours_to_deadline: number | null;
  urgency_reliable: boolean;
}

export interface Route1BookletPriceRow {
  productId?: string;
  size: BookletSize | string;
  quantity: number;
  pages: number;
  attributes?: Record<string, string | number>;
  price: number;
}

export interface CourierDistanceBand {
  max: number;
  gophr: number;
  dnp: number;
  label: string;
  operationalBufferHours: number;
}

export interface PostcodeDistanceEntry {
  miles: number;
  source: string;
}

export type PostcodeDistanceMap = Record<string, PostcodeDistanceEntry>;

export interface QuantityLimitTier {
  maxHours: number;
  maxQty: number;
  choices: number[];
}

export interface BusinessConfig {
  productName: string;
  defaultPaper: string;
  recommendedCoverStock: string;
  recommendedInnerStock: string;
  coverStockOptions: string[];
  innerStockOptions: string[];
  allowedSizes: BookletSize[];
  allowedOrientations: BookletOrientation[];
  pageRange: {
    min: number;
    max: number;
    multiple: number;
    quickChoices: number[];
  };
  quantityLimitsByHours: QuantityLimitTier[];
  defaultQuantityChoices: number[];
  printedEasy: {
    customerCutoffMinutes: number;
    orderCutoffMinutes: number;
    standardDeliveryHour: number;
    ownCollectReadyHour: number;
    ownCourierBufferMinutes: number;
  };
  hrjRouting: {
    safeNextDayDeliveryHour: number;
    minHoursEarlyTomorrow: number;
    minHoursDirect: number;
    originAddress: string;
  };
  rfcModel: {
    baseExpectedHours: number;
    minExpectedHours: number;
    a4AdderHours: number;
    p80AnchorHours: number;
    p80BlendWeight: number;
  };
  courierRules: {
    gophrCompressedThresholdHours: number;
    dnpOohSurcharge: number;
    oohStartHour: number;
    oohEndHour: number;
    earlyDeliveryHourCutoff: number;
    travelBaseHours: number;
    travelMinHours: number;
    travelSpeedMph: number;
  };
  pricingRules: {
    standardThresholdHours: number;
    standardDeliveryAllowance: number;
    protectedCostFloorMultiplier: number;
    quoteRoundingStep: number;
    compressionRoundingStep: number;
    deadlineCompressionPoints: [number, number][];
  };
}

export interface SupplierRouteEvaluation {
  supplier: string;
  eligible: boolean;
  route: string;
  reason: string;
  cutoff: string;
  confidence: string;
  overnight?: boolean;
}

export interface RfcForecast {
  start: string;
  expectedHours: number;
  conservativeHours: number;
  expectedRfc: string;
  conservativeRfc: string;
  confidence: 'Medium' | 'Low';
}

export interface DistanceResolution {
  miles: number | null;
  source: string;
  label: string;
}

export interface CourierOptionEvaluation {
  name: 'Gophr' | 'DNP';
  eligible: boolean;
  baseline: number | null;
  protected: number | null;
  ooh?: number;
  reason: string;
  expWin: number;
  consWin: number;
  travel: number | null;
  overnight?: boolean;
  requiredWindow?: number | null;
}

export interface CourierComparisonResult {
  dist: DistanceResolution;
  band: CourierDistanceBand | null;
  gophr: CourierOptionEvaluation | null;
  dnp: CourierOptionEvaluation | null;
  selected: CourierOptionEvaluation | null;
  expectedWindow?: number;
  conservativeWindow?: number;
  travel?: number | null;
}

export interface LiveResilienceResult {
  status: TrafficLightStatus;
  productionStatus: TrafficLightStatus;
  deliveryStatus: TrafficLightStatus;
  auto: boolean;
  rfc?: RfcForecast;
  route?: string;
  resilience?: 'High' | 'Medium' | 'Low' | 'Unknown';
  expectedBuffer?: number;
  conservativeBuffer?: number;
  recovery?: number | null;
  reasons: string[];
  couriers?: CourierComparisonResult;
  productionReason?: string;
  deliveryReason?: string;
}

export interface HrjComparableJob extends HrjHistoricalJob {
  distance: number;
  similarity: number;
  recency: number;
  weight: number;
}

export interface HrjPricingModelResult {
  target: number;
  expected: number;
  protectedAllowance: number;
  p80: number;
  p90: number;
  median: number;
  structural: number;
  effectiveSupport: number;
  support: 'Strong' | 'Moderate' | 'Weak';
  comparables: HrjComparableJob[];
  model: string;
}

export interface HrjProductionCostResult {
  expected: number;
  conservative: number;
  opening: number;
  targetLow: number;
  targetHigh: number;
  autoAccept: number;
  model: HrjPricingModelResult | null;
}

export interface DnpSellingComparable extends DnpSellingObservation {
  distance: number;
  weight: number;
  recency: number;
}

export interface DnpSellingPriceModelResult {
  p25: number;
  p50: number;
  p65: number;
  p75: number;
  p90: number;
  selectedPercentile: number;
  historical: number;
  floor: number;
  quote: number;
  effectiveSupport: number;
  support: 'Strong' | 'Moderate' | 'Weak';
  comparables: DnpSellingComparable[];
  model: string;
}

export interface DeadlineCompressionResult {
  premium: number;
  total: number | null;
  label: string;
}

export interface StandardPriceResult {
  supplier: number;
  qty: number;
  page: number;
  deliveryAllowance: number;
  quote: number;
  estimated: boolean;
}

export interface EvaluationResponse {
  spec: OrderSpecification;
  productDef?: ProductDefinition;
  progress: {
    done: number;
    total: number;
    percent: number;
    progressText: string;
    missingFields: string[];
    isComplete: boolean;
    quoteInputsComplete: boolean;
  };
  quoteState: {
    mode: 'incomplete' | 'quote' | 'checking';
    standard: boolean;
    total: number | null;
    vatAmount?: number;
    vatRate?: number;
    commitmentText: string | null;
    priceSubtext: string | null;
    whyHeld?: string;
    botCompletionMessage?: string;
  };
  diagnosticsHtml: string;
  diagnosticsData: {
    hoursLeft: number | null;
    feasibility: { ok: boolean; why: string; live: LiveResilienceResult };
    peRoute: SupplierRouteEvaluation | null;
    hrjRoute: SupplierRouteEvaluation | null;
    hrjCost: HrjProductionCostResult;
    sellingModel: DnpSellingPriceModelResult | null;
    compression: DeadlineCompressionResult;
    standardPrice: StandardPriceResult | null;
  };
}

export type ConversationStepKey = string | null;

export interface ConversationChoice {
  label: string;
  value: string | number;
}

export interface ConversationResponse {
  spec: OrderSpecification;
  currentStep: ConversationStepKey;
  botMessages: string[];
  choices: ConversationChoice[];
  showAttach: boolean;
  evaluation: EvaluationResponse;
}
