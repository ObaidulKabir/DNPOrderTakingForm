import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  BookletSize,
  BusinessConfig,
  CourierDistanceBand,
  DnpSellingObservation,
  HrjHistoricalJob,
  PostcodeDistanceEntry,
  PostcodeDistanceMap,
  ProductAttributeDefinition,
  ProductDefinition,
  Route1BookletPriceRow,
  StandardPriceMatrixRow,
  SupplierProductCapability,
} from '../domain/types.js';
import { IDataRepository } from './IDataRepository.js';

export interface PgQueryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  exec?(sql: string): Promise<unknown>;
  close?(): Promise<void>;
}

/**
 * Wraps a standard `pg.Pool` or `PGlite` embedded PostgreSQL engine behind a unified async query interface.
 */
export class PgPoolAdapter implements PgQueryable {
  constructor(private readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.pool.query(text, values);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class PGliteAdapter implements PgQueryable {
  constructor(private readonly db: PGlite) {}

  async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.db.query<T>(text, values);
    return { rows: res.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export class PostgresDataRepository implements IDataRepository {
  constructor(private readonly db: PgQueryable) {}

  /**
   * Factory that connects to a real PostgreSQL server if `connectionString` is provided,
   * or boots an embedded PostgreSQL (PGlite) instance with full JSONB + GIN index support.
   */
  static async create(options?: {
    connectionString?: string;
    dataDir?: string;
    seedFrom?: IDataRepository;
  }): Promise<PostgresDataRepository> {
    let client: PgQueryable;
    if (options?.connectionString) {
      const pool = new pg.Pool({ connectionString: options.connectionString });
      client = new PgPoolAdapter(pool);
    } else {
      const pglite = new PGlite(options?.dataDir);
      await pglite.waitReady;
      client = new PGliteAdapter(pglite);
    }

    const repo = new PostgresDataRepository(client);
    await repo.initSchema();

    if (options?.seedFrom) {
      await repo.seedIfEmpty(options.seedFrom);
    }

    return repo;
  }

  async close(): Promise<void> {
    if (this.db.close) {
      await this.db.close();
    }
  }

  async initSchema(): Promise<void> {
    const ddl = `
      CREATE TABLE IF NOT EXISTS business_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        singular_name TEXT NOT NULL,
        category TEXT NOT NULL,
        vat_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        default_paper TEXT NOT NULL,
        keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
        stock_recommendation JSONB,
        rfc_model_config JSONB NOT NULL,
        pricing_config JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS product_attributes (
        id SERIAL PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        attribute_key TEXT NOT NULL,
        label TEXT NOT NULL,
        input_type TEXT NOT NULL,
        wide_input BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 1,
        required BOOLEAN NOT NULL DEFAULT TRUE,
        default_value JSONB,
        placeholder TEXT,
        suffix TEXT,
        question_prompt TEXT NOT NULL,
        validation_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
        quick_choices JSONB NOT NULL DEFAULT '[]'::jsonb,
        composite_group TEXT,
        UNIQUE(product_id, attribute_key)
      );

      CREATE TABLE IF NOT EXISTS supplier_product_capabilities (
        supplier_id TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        supported BOOLEAN NOT NULL DEFAULT TRUE,
        excluded_combinations JSONB NOT NULL DEFAULT '[]'::jsonb,
        quantity_limits_by_hours JSONB NOT NULL DEFAULT '[]'::jsonb,
        default_quantity_choices JSONB NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY (supplier_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS standard_price_matrix (
        id SERIAL PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        supplier_id TEXT NOT NULL DEFAULT 'route1',
        size TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        pages INTEGER,
        attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        price DOUBLE PRECISION NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_standard_price_product_size
        ON standard_price_matrix (product_id, size, quantity);
      CREATE INDEX IF NOT EXISTS idx_standard_price_attrs_gin
        ON standard_price_matrix USING GIN (attributes_json);

      CREATE TABLE IF NOT EXISTS hrj_historical_jobs (
        order_id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL DEFAULT 'saddle-stitched-booklets',
        vendor_due DOUBLE PRECISION NOT NULL,
        qty DOUBLE PRECISION NOT NULL,
        size2 TEXT NOT NULL,
        pages DOUBLE PRECISION NOT NULL DEFAULT 0,
        attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        hours_to_deadline DOUBLE PRECISION,
        paid_at TEXT NOT NULL,
        source TEXT NOT NULL,
        urgency_reliable BOOLEAN NOT NULL DEFAULT TRUE
      );

      CREATE INDEX IF NOT EXISTS idx_hrj_jobs_product ON hrj_historical_jobs (product_id);
      CREATE INDEX IF NOT EXISTS idx_hrj_jobs_attrs_gin ON hrj_historical_jobs USING GIN (attributes_json);

      CREATE TABLE IF NOT EXISTS dnp_selling_observations (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL DEFAULT 'saddle-stitched-booklets',
        source TEXT NOT NULL,
        qty DOUBLE PRECISION NOT NULL,
        size2 TEXT NOT NULL,
        pages DOUBLE PRECISION NOT NULL DEFAULT 0,
        attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        sell DOUBLE PRECISION NOT NULL,
        vendor_due DOUBLE PRECISION NOT NULL,
        paid_at TEXT NOT NULL,
        hours_to_deadline DOUBLE PRECISION,
        urgency_reliable BOOLEAN NOT NULL DEFAULT TRUE
      );

      CREATE INDEX IF NOT EXISTS idx_dnp_obs_product ON dnp_selling_observations (product_id);
      CREATE INDEX IF NOT EXISTS idx_dnp_obs_attrs_gin ON dnp_selling_observations USING GIN (attributes_json);

      CREATE TABLE IF NOT EXISTS courier_distance_bands (
        max_miles DOUBLE PRECISION PRIMARY KEY,
        gophr DOUBLE PRECISION NOT NULL,
        dnp DOUBLE PRECISION NOT NULL,
        label TEXT NOT NULL,
        operational_buffer_hours DOUBLE PRECISION NOT NULL
      );

      CREATE TABLE IF NOT EXISTS postcode_distances (
        postcode TEXT PRIMARY KEY,
        miles DOUBLE PRECISION NOT NULL,
        source TEXT NOT NULL
      );
    `;

    if (this.db.exec) {
      await this.db.exec(ddl);
    } else {
      await this.db.query(ddl);
    }
  }

  async seedIfEmpty(source: IDataRepository): Promise<void> {
    const existing = await this.db.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM products');
    if ((existing.rows[0]?.cnt ?? 0) > 0) {
      return;
    }

    const [
      config,
      products,
      capabilities,
      hrjJobs,
      dnpObs,
      route1Rows,
      bands,
      postcodes,
    ] = await Promise.all([
      source.getBusinessConfig(),
      source.getProducts(),
      source.getSupplierCapabilities(),
      source.getHrjHistoricalJobs(),
      source.getDnpSellingObservations(),
      source.getRoute1StandardPrices(),
      source.getCourierDistanceBands(),
      source.getPostcodeDistances(),
    ]);

    await this.db.query(
      'INSERT INTO business_config (id, config_json) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET config_json = EXCLUDED.config_json',
      [JSON.stringify(config)]
    );

    for (const prod of products) {
      await this.upsertProduct(prod);
    }

    for (const cap of capabilities) {
      await this.upsertSupplierCapability(cap);
    }

    await this.saveHrjHistoricalJobs(hrjJobs);
    await this.saveDnpSellingObservations(dnpObs);
    await this.saveRoute1StandardPrices(route1Rows);
    await this.saveCourierDistanceBands(bands);

    for (const [pc, entry] of Object.entries(postcodes)) {
      await this.upsertPostcodeDistance(pc, entry);
    }
  }

  // ---- MULTI-PRODUCT CATALOG & ATTRIBUTES ----

  async getProducts(): Promise<ProductDefinition[]> {
    const prodRes = await this.db.query<{
      id: string;
      name: string;
      singular_name: string;
      category: string;
      vat_rate: number;
      active: boolean;
      default_paper: string;
      keywords: string[];
      stock_recommendation: ProductDefinition['stockRecommendation'];
      rfc_model_config: ProductDefinition['rfcModelConfig'];
      pricing_config: ProductDefinition['pricingConfig'];
    }>('SELECT * FROM products ORDER BY id ASC');

    const attrRes = await this.db.query<{
      id: number;
      product_id: string;
      attribute_key: string;
      label: string;
      input_type: ProductAttributeDefinition['inputType'];
      wide_input: boolean;
      sort_order: number;
      required: boolean;
      default_value: string | number | null;
      placeholder: string | null;
      suffix: string | null;
      question_prompt: string;
      validation_rules: ProductAttributeDefinition['validationRules'];
      quick_choices: ProductAttributeDefinition['quickChoices'];
      composite_group: string | null;
    }>('SELECT * FROM product_attributes ORDER BY product_id ASC, sort_order ASC');

    const attrsByProduct = new Map<string, ProductAttributeDefinition[]>();
    for (const a of attrRes.rows) {
      const list = attrsByProduct.get(a.product_id) || [];
      list.push({
        id: a.id,
        productId: a.product_id,
        attributeKey: a.attribute_key,
        label: a.label,
        inputType: a.input_type,
        wideInput: a.wide_input,
        sortOrder: a.sort_order,
        required: a.required,
        defaultValue: a.default_value ?? undefined,
        placeholder: a.placeholder ?? undefined,
        suffix: a.suffix ?? undefined,
        questionPrompt: a.question_prompt,
        validationRules: a.validation_rules || {},
        quickChoices: a.quick_choices || [],
        compositeGroup: a.composite_group ?? undefined,
      });
      attrsByProduct.set(a.product_id, list);
    }

    return prodRes.rows.map((p) => ({
      id: p.id,
      name: p.name,
      singularName: p.singular_name,
      category: p.category,
      vatRate: Number(p.vat_rate),
      active: Boolean(p.active),
      defaultPaper: p.default_paper,
      keywords: p.keywords || [],
      stockRecommendation: p.stock_recommendation || null,
      rfcModelConfig: p.rfc_model_config,
      pricingConfig: p.pricing_config,
      attributes: attrsByProduct.get(p.id) || [],
    }));
  }

  async getProductById(productId: string): Promise<ProductDefinition | null> {
    const all = await this.getProducts();
    return all.find((p) => p.id === productId) || null;
  }

  async upsertProduct(product: ProductDefinition): Promise<ProductDefinition> {
    await this.db.query(
      `INSERT INTO products (
        id, name, singular_name, category, vat_rate, active, default_paper,
        keywords, stock_recommendation, rfc_model_config, pricing_config, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        singular_name = EXCLUDED.singular_name,
        category = EXCLUDED.category,
        vat_rate = EXCLUDED.vat_rate,
        active = EXCLUDED.active,
        default_paper = EXCLUDED.default_paper,
        keywords = EXCLUDED.keywords,
        stock_recommendation = EXCLUDED.stock_recommendation,
        rfc_model_config = EXCLUDED.rfc_model_config,
        pricing_config = EXCLUDED.pricing_config,
        updated_at = NOW()`,
      [
        product.id,
        product.name,
        product.singularName,
        product.category,
        product.vatRate,
        product.active,
        product.defaultPaper,
        JSON.stringify(product.keywords || []),
        product.stockRecommendation ? JSON.stringify(product.stockRecommendation) : null,
        JSON.stringify(product.rfcModelConfig),
        JSON.stringify(product.pricingConfig),
      ]
    );

    await this.db.query('DELETE FROM product_attributes WHERE product_id = $1', [product.id]);

    for (const attr of product.attributes || []) {
      await this.db.query(
        `INSERT INTO product_attributes (
          product_id, attribute_key, label, input_type, wide_input, sort_order,
          required, default_value, placeholder, suffix, question_prompt,
          validation_rules, quick_choices, composite_group
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13::jsonb, $14)`,
        [
          product.id,
          attr.attributeKey,
          attr.label,
          attr.inputType,
          Boolean(attr.wideInput),
          attr.sortOrder,
          Boolean(attr.required),
          attr.defaultValue !== undefined ? JSON.stringify(attr.defaultValue) : null,
          attr.placeholder ?? null,
          attr.suffix ?? null,
          attr.questionPrompt,
          JSON.stringify(attr.validationRules || {}),
          JSON.stringify(attr.quickChoices || []),
          attr.compositeGroup ?? null,
        ]
      );
    }

    return (await this.getProductById(product.id))!;
  }

  async getSupplierCapabilities(productId?: string): Promise<SupplierProductCapability[]> {
    const sql = productId
      ? 'SELECT * FROM supplier_product_capabilities WHERE product_id = $1 ORDER BY supplier_id ASC'
      : 'SELECT * FROM supplier_product_capabilities ORDER BY product_id ASC, supplier_id ASC';
    const params = productId ? [productId] : [];
    const res = await this.db.query<{
      supplier_id: string;
      supplier_name: string;
      product_id: string;
      supported: boolean;
      excluded_combinations: SupplierProductCapability['excludedCombinations'];
      quantity_limits_by_hours: SupplierProductCapability['quantityLimitsByHours'];
      default_quantity_choices: number[];
    }>(sql, params);

    return res.rows.map((r) => ({
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      productId: r.product_id,
      supported: Boolean(r.supported),
      excludedCombinations: r.excluded_combinations || [],
      quantityLimitsByHours: r.quantity_limits_by_hours || [],
      defaultQuantityChoices: r.default_quantity_choices || [],
    }));
  }

  async upsertSupplierCapability(capability: SupplierProductCapability): Promise<SupplierProductCapability> {
    await this.db.query(
      `INSERT INTO supplier_product_capabilities (
        supplier_id, supplier_name, product_id, supported,
        excluded_combinations, quantity_limits_by_hours, default_quantity_choices
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
      ON CONFLICT (supplier_id, product_id) DO UPDATE SET
        supplier_name = EXCLUDED.supplier_name,
        supported = EXCLUDED.supported,
        excluded_combinations = EXCLUDED.excluded_combinations,
        quantity_limits_by_hours = EXCLUDED.quantity_limits_by_hours,
        default_quantity_choices = EXCLUDED.default_quantity_choices`,
      [
        capability.supplierId,
        capability.supplierName,
        capability.productId,
        capability.supported,
        JSON.stringify(capability.excludedCombinations || []),
        JSON.stringify(capability.quantityLimitsByHours || []),
        JSON.stringify(capability.defaultQuantityChoices || []),
      ]
    );
    return capability;
  }

  async getStandardPriceMatrix(productId?: string): Promise<StandardPriceMatrixRow[]> {
    const sql = productId
      ? 'SELECT * FROM standard_price_matrix WHERE product_id = $1 ORDER BY id ASC'
      : 'SELECT * FROM standard_price_matrix ORDER BY id ASC';
    const res = await this.db.query<{
      id: number;
      product_id: string;
      supplier_id: string;
      size: string;
      quantity: number;
      pages: number | null;
      attributes_json: Record<string, string | number>;
      price: number;
    }>(sql, productId ? [productId] : []);

    return res.rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      supplierId: r.supplier_id,
      size: r.size,
      quantity: Number(r.quantity),
      pages: r.pages != null ? Number(r.pages) : null,
      attributes: r.attributes_json || {},
      price: Number(r.price),
    }));
  }

  async saveStandardPriceMatrix(productId: string, rows: StandardPriceMatrixRow[]): Promise<void> {
    await this.db.query('DELETE FROM standard_price_matrix WHERE product_id = $1', [productId]);
    if (!rows.length) return;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    rows.forEach((r, idx) => {
      const base = idx * 6;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7})`
      );
      values.push(
        productId,
        r.supplierId || 'route1',
        r.size,
        r.quantity,
        r.pages ?? null,
        JSON.stringify(r.attributes || {}),
        r.price
      );
    });
    // Use chunked multi-row insert for speed
    const chunkSize = 100;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const slice = rows.slice(i, i + chunkSize);
      const chunkVals: unknown[] = [];
      const chunkPh: string[] = [];
      slice.forEach((r, j) => {
        const b = j * 7;
        chunkPh.push(
          `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb, $${b + 7})`
        );
        chunkVals.push(
          productId,
          r.supplierId || 'route1',
          r.size,
          r.quantity,
          r.pages ?? null,
          JSON.stringify(r.attributes || {}),
          r.price
        );
      });
      await this.db.query(
        `INSERT INTO standard_price_matrix (product_id, supplier_id, size, quantity, pages, attributes_json, price) VALUES ${chunkPh.join(', ')}`,
        chunkVals
      );
    }
  }

  // ---- BUSINESS CONFIG ----

  async getBusinessConfig(): Promise<BusinessConfig> {
    const res = await this.db.query<{ config_json: BusinessConfig }>(
      'SELECT config_json FROM business_config WHERE id = 1'
    );
    if (!res.rows.length) {
      throw new Error('BusinessConfig not initialized in PostgreSQL');
    }
    return res.rows[0].config_json;
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
    await this.db.query(
      'INSERT INTO business_config (id, config_json, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = NOW()',
      [JSON.stringify(merged)]
    );
    return merged;
  }

  // ---- HISTORICAL OBSERVATIONS (RELATIONAL + JSONB) ----

  async getHrjHistoricalJobs(productId?: string): Promise<HrjHistoricalJob[]> {
    const sql = productId
      ? 'SELECT * FROM hrj_historical_jobs WHERE product_id = $1 ORDER BY order_id ASC'
      : 'SELECT * FROM hrj_historical_jobs ORDER BY order_id ASC';
    const res = await this.db.query<{
      order_id: string;
      product_id: string;
      vendor_due: number;
      qty: number;
      size2: string;
      pages: number;
      attributes_json: Record<string, string | number>;
      hours_to_deadline: number | null;
      paid_at: string;
      source: string;
      urgency_reliable: boolean;
    }>(sql, productId ? [productId] : []);

    return res.rows.map((r) => ({
      order_id: r.order_id,
      product_id: r.product_id,
      vendor_due: Number(r.vendor_due),
      qty: Number(r.qty),
      size2: r.size2,
      pages: Number(r.pages),
      attributes: r.attributes_json || {},
      hours_to_deadline: r.hours_to_deadline != null ? Number(r.hours_to_deadline) : null,
      paid_at: r.paid_at,
      source: r.source,
      urgency_reliable: Boolean(r.urgency_reliable),
    }));
  }

  async saveHrjHistoricalJobs(jobs: HrjHistoricalJob[]): Promise<void> {
    await this.db.query('DELETE FROM hrj_historical_jobs');
    for (const j of jobs) {
      await this.addHrjHistoricalJob(j);
    }
  }

  async addHrjHistoricalJob(job: HrjHistoricalJob): Promise<HrjHistoricalJob[]> {
    const productId = job.product_id || 'saddle-stitched-booklets';
    const attrs = job.attributes || { pages: job.pages, size: job.size2 };
    await this.db.query(
      `INSERT INTO hrj_historical_jobs (
        order_id, product_id, vendor_due, qty, size2, pages,
        attributes_json, hours_to_deadline, paid_at, source, urgency_reliable
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
      ON CONFLICT (order_id) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        vendor_due = EXCLUDED.vendor_due,
        qty = EXCLUDED.qty,
        size2 = EXCLUDED.size2,
        pages = EXCLUDED.pages,
        attributes_json = EXCLUDED.attributes_json,
        hours_to_deadline = EXCLUDED.hours_to_deadline,
        paid_at = EXCLUDED.paid_at,
        source = EXCLUDED.source,
        urgency_reliable = EXCLUDED.urgency_reliable`,
      [
        job.order_id,
        productId,
        job.vendor_due,
        job.qty,
        job.size2,
        job.pages,
        JSON.stringify(attrs),
        job.hours_to_deadline,
        job.paid_at,
        job.source,
        Boolean(job.urgency_reliable),
      ]
    );
    return this.getHrjHistoricalJobs();
  }

  async getDnpSellingObservations(productId?: string): Promise<DnpSellingObservation[]> {
    const sql = productId
      ? 'SELECT * FROM dnp_selling_observations WHERE product_id = $1 ORDER BY id ASC'
      : 'SELECT * FROM dnp_selling_observations ORDER BY id ASC';
    const res = await this.db.query<{
      id: string;
      product_id: string;
      source: string;
      qty: number;
      size2: string;
      pages: number;
      attributes_json: Record<string, string | number>;
      sell: number;
      vendor_due: number;
      paid_at: string;
      hours_to_deadline: number | null;
      urgency_reliable: boolean;
    }>(sql, productId ? [productId] : []);

    return res.rows.map((r) => ({
      id: r.id,
      product_id: r.product_id,
      source: r.source,
      qty: Number(r.qty),
      size2: r.size2,
      pages: Number(r.pages),
      attributes: r.attributes_json || {},
      sell: Number(r.sell),
      vendor_due: Number(r.vendor_due),
      paid_at: r.paid_at,
      hours_to_deadline: r.hours_to_deadline != null ? Number(r.hours_to_deadline) : null,
      urgency_reliable: Boolean(r.urgency_reliable),
    }));
  }

  async saveDnpSellingObservations(observations: DnpSellingObservation[]): Promise<void> {
    await this.db.query('DELETE FROM dnp_selling_observations');
    for (const o of observations) {
      await this.addDnpSellingObservation(o);
    }
  }

  async addDnpSellingObservation(obs: DnpSellingObservation): Promise<DnpSellingObservation[]> {
    const productId = obs.product_id || 'saddle-stitched-booklets';
    const attrs = obs.attributes || { pages: obs.pages, size: obs.size2 };
    await this.db.query(
      `INSERT INTO dnp_selling_observations (
        id, product_id, source, qty, size2, pages,
        attributes_json, sell, vendor_due, paid_at, hours_to_deadline, urgency_reliable
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        source = EXCLUDED.source,
        qty = EXCLUDED.qty,
        size2 = EXCLUDED.size2,
        pages = EXCLUDED.pages,
        attributes_json = EXCLUDED.attributes_json,
        sell = EXCLUDED.sell,
        vendor_due = EXCLUDED.vendor_due,
        paid_at = EXCLUDED.paid_at,
        hours_to_deadline = EXCLUDED.hours_to_deadline,
        urgency_reliable = EXCLUDED.urgency_reliable`,
      [
        obs.id,
        productId,
        obs.source,
        obs.qty,
        obs.size2,
        obs.pages,
        JSON.stringify(attrs),
        obs.sell,
        obs.vendor_due,
        obs.paid_at,
        obs.hours_to_deadline,
        Boolean(obs.urgency_reliable),
      ]
    );
    return this.getDnpSellingObservations();
  }

  async getRoute1StandardPrices(productId?: string): Promise<Route1BookletPriceRow[]> {
    const rows = await this.getStandardPriceMatrix(productId);
    return rows.map((r) => ({
      productId: r.productId,
      size: r.size as BookletSize,
      quantity: r.quantity,
      pages: r.pages ?? Number(r.attributes?.pages ?? 0),
      attributes: r.attributes,
      price: r.price,
    }));
  }

  async saveRoute1StandardPrices(rows: Route1BookletPriceRow[]): Promise<void> {
    await this.db.query('DELETE FROM standard_price_matrix');
    const chunkSize = 100;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const slice = rows.slice(i, i + chunkSize);
      const chunkVals: unknown[] = [];
      const chunkPh: string[] = [];
      slice.forEach((r, j) => {
        const b = j * 6;
        const productId = r.productId || 'saddle-stitched-booklets';
        const attrs = r.attributes || (r.pages ? { pages: r.pages } : {});
        chunkPh.push(`($${b + 1}, 'route1', $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb, $${b + 6})`);
        chunkVals.push(productId, r.size, r.quantity, r.pages ?? null, JSON.stringify(attrs), r.price);
      });
      await this.db.query(
        `INSERT INTO standard_price_matrix (product_id, supplier_id, size, quantity, pages, attributes_json, price) VALUES ${chunkPh.join(', ')}`,
        chunkVals
      );
    }
  }

  // ---- COURIER BANDS & POSTCODES ----

  async getCourierDistanceBands(): Promise<CourierDistanceBand[]> {
    const res = await this.db.query<{
      max_miles: number;
      gophr: number;
      dnp: number;
      label: string;
      operational_buffer_hours: number;
    }>('SELECT * FROM courier_distance_bands ORDER BY max_miles ASC');

    return res.rows.map((r) => ({
      max: Number(r.max_miles),
      gophr: Number(r.gophr),
      dnp: Number(r.dnp),
      label: r.label,
      operationalBufferHours: Number(r.operational_buffer_hours),
    }));
  }

  async saveCourierDistanceBands(bands: CourierDistanceBand[]): Promise<void> {
    await this.db.query('DELETE FROM courier_distance_bands');
    for (const b of bands) {
      await this.db.query(
        `INSERT INTO courier_distance_bands (max_miles, gophr, dnp, label, operational_buffer_hours)
         VALUES ($1, $2, $3, $4, $5)`,
        [b.max, b.gophr, b.dnp, b.label, b.operationalBufferHours]
      );
    }
  }

  async getPostcodeDistances(): Promise<PostcodeDistanceMap> {
    const res = await this.db.query<{ postcode: string; miles: number; source: string }>(
      'SELECT postcode, miles, source FROM postcode_distances'
    );
    const map: PostcodeDistanceMap = {};
    for (const r of res.rows) {
      map[r.postcode] = { miles: Number(r.miles), source: r.source };
    }
    return map;
  }

  async upsertPostcodeDistance(postcode: string, entry: PostcodeDistanceEntry): Promise<PostcodeDistanceMap> {
    const normalized = postcode.toUpperCase().replace(/\s+/g, '').trim();
    await this.db.query(
      `INSERT INTO postcode_distances (postcode, miles, source)
       VALUES ($1, $2, $3)
       ON CONFLICT (postcode) DO UPDATE SET miles = EXCLUDED.miles, source = EXCLUDED.source`,
      [normalized, entry.miles, entry.source]
    );
    return this.getPostcodeDistances();
  }
}
