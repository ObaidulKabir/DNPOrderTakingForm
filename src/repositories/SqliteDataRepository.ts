import { createRequire } from 'node:module';
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

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

export class SqliteDataRepository implements IDataRepository {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS business_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json_value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        json_value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS supplier_capabilities (
        supplier_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        json_value TEXT NOT NULL,
        PRIMARY KEY (supplier_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS hrj_historical_jobs (
        order_id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL DEFAULT 'saddle-stitched-booklets',
        vendor_due REAL NOT NULL,
        qty REAL NOT NULL,
        size2 TEXT NOT NULL,
        pages REAL NOT NULL,
        attributes_json TEXT NOT NULL DEFAULT '{}',
        hours_to_deadline REAL,
        paid_at TEXT NOT NULL,
        source TEXT NOT NULL,
        urgency_reliable INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dnp_selling_observations (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL DEFAULT 'saddle-stitched-booklets',
        source TEXT NOT NULL,
        qty REAL NOT NULL,
        size2 TEXT NOT NULL,
        pages REAL NOT NULL,
        attributes_json TEXT NOT NULL DEFAULT '{}',
        sell REAL NOT NULL,
        vendor_due REAL NOT NULL,
        paid_at TEXT NOT NULL,
        hours_to_deadline REAL,
        urgency_reliable INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS route1_standard_prices (
        product_id TEXT NOT NULL DEFAULT 'saddle-stitched-booklets',
        size TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        pages INTEGER NOT NULL,
        attributes_json TEXT NOT NULL DEFAULT '{}',
        price REAL NOT NULL,
        PRIMARY KEY (product_id, size, quantity, pages)
      );

      CREATE TABLE IF NOT EXISTS courier_distance_bands (
        max REAL PRIMARY KEY,
        gophr REAL NOT NULL,
        dnp REAL NOT NULL,
        label TEXT NOT NULL,
        operational_buffer_hours REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS postcode_distances (
        postcode TEXT PRIMARY KEY,
        miles REAL NOT NULL,
        source TEXT NOT NULL
      );
    `);
  }

  static async createSeeded(source: IDataRepository, dbPath: string = ':memory:'): Promise<SqliteDataRepository> {
    const repo = new SqliteDataRepository(dbPath);
    const [config, products, capabilities, hrjJobs, dnpObs, route1Rows, bands, postcodes] = await Promise.all([
      source.getBusinessConfig(),
      source.getProducts(),
      source.getSupplierCapabilities(),
      source.getHrjHistoricalJobs(),
      source.getDnpSellingObservations(),
      source.getRoute1StandardPrices(),
      source.getCourierDistanceBands(),
      source.getPostcodeDistances(),
    ]);

    repo.db
      .prepare('INSERT OR REPLACE INTO business_config (id, json_value) VALUES (1, ?)')
      .run(JSON.stringify(config));
    for (const p of products) {
      await repo.upsertProduct(p);
    }
    for (const c of capabilities) {
      await repo.upsertSupplierCapability(c);
    }
    await repo.saveHrjHistoricalJobs(hrjJobs);
    await repo.saveDnpSellingObservations(dnpObs);
    await repo.saveRoute1StandardPrices(route1Rows);
    await repo.saveCourierDistanceBands(bands);
    for (const [pc, entry] of Object.entries(postcodes)) {
      await repo.upsertPostcodeDistance(pc, entry);
    }
    return repo;
  }

  async getProducts(): Promise<ProductDefinition[]> {
    const rows = this.db.prepare('SELECT json_value FROM products').all() as Array<{ json_value: string }>;
    return rows.map((r) => JSON.parse(r.json_value) as ProductDefinition);
  }

  async getProductById(productId: string): Promise<ProductDefinition | null> {
    const row = this.db.prepare('SELECT json_value FROM products WHERE id = ?').get(productId) as
      | { json_value: string }
      | undefined;
    return row ? (JSON.parse(row.json_value) as ProductDefinition) : null;
  }

  async upsertProduct(product: ProductDefinition): Promise<ProductDefinition> {
    this.db
      .prepare('INSERT OR REPLACE INTO products (id, json_value) VALUES (?, ?)')
      .run(product.id, JSON.stringify(product));
    return product;
  }

  async getSupplierCapabilities(productId?: string): Promise<SupplierProductCapability[]> {
    const rows = (
      productId
        ? this.db.prepare('SELECT json_value FROM supplier_capabilities WHERE product_id = ?').all(productId)
        : this.db.prepare('SELECT json_value FROM supplier_capabilities').all()
    ) as Array<{ json_value: string }>;
    return rows.map((r) => JSON.parse(r.json_value) as SupplierProductCapability);
  }

  async upsertSupplierCapability(capability: SupplierProductCapability): Promise<SupplierProductCapability> {
    this.db
      .prepare('INSERT OR REPLACE INTO supplier_capabilities (supplier_id, product_id, json_value) VALUES (?, ?, ?)')
      .run(capability.supplierId, capability.productId, JSON.stringify(capability));
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
    const row = this.db.prepare('SELECT json_value FROM business_config WHERE id = 1').get() as
      | { json_value: string }
      | undefined;
    if (!row) {
      throw new Error('BusinessConfig not initialized in SQLite repository');
    }
    return JSON.parse(row.json_value) as BusinessConfig;
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
    this.db
      .prepare('INSERT OR REPLACE INTO business_config (id, json_value) VALUES (1, ?)')
      .run(JSON.stringify(merged));
    return merged;
  }

  async getHrjHistoricalJobs(productId?: string): Promise<HrjHistoricalJob[]> {
    const rows = (
      productId
        ? this.db.prepare('SELECT * FROM hrj_historical_jobs WHERE product_id = ?').all(productId)
        : this.db.prepare('SELECT * FROM hrj_historical_jobs').all()
    ) as Array<{
      order_id: string;
      product_id: string;
      vendor_due: number;
      qty: number;
      size2: string;
      pages: number;
      attributes_json: string;
      hours_to_deadline: number | null;
      paid_at: string;
      source: string;
      urgency_reliable: number;
    }>;
    return rows.map((r) => ({
      order_id: r.order_id,
      product_id: r.product_id,
      vendor_due: r.vendor_due,
      qty: r.qty,
      size2: r.size2,
      pages: r.pages,
      attributes: JSON.parse(r.attributes_json || '{}'),
      hours_to_deadline: r.hours_to_deadline,
      paid_at: r.paid_at,
      source: r.source,
      urgency_reliable: Boolean(r.urgency_reliable),
    }));
  }

  async saveHrjHistoricalJobs(jobs: HrjHistoricalJob[]): Promise<void> {
    this.db.exec('DELETE FROM hrj_historical_jobs');
    for (const j of jobs) {
      await this.addHrjHistoricalJob(j);
    }
  }

  async addHrjHistoricalJob(job: HrjHistoricalJob): Promise<HrjHistoricalJob[]> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO hrj_historical_jobs
      (order_id, product_id, vendor_due, qty, size2, pages, attributes_json, hours_to_deadline, paid_at, source, urgency_reliable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      job.order_id,
      job.product_id || 'saddle-stitched-booklets',
      job.vendor_due,
      job.qty,
      job.size2,
      job.pages,
      JSON.stringify(job.attributes || { pages: job.pages }),
      job.hours_to_deadline,
      job.paid_at,
      job.source,
      job.urgency_reliable ? 1 : 0
    );
    return this.getHrjHistoricalJobs();
  }

  async getDnpSellingObservations(productId?: string): Promise<DnpSellingObservation[]> {
    const rows = (
      productId
        ? this.db.prepare('SELECT * FROM dnp_selling_observations WHERE product_id = ?').all(productId)
        : this.db.prepare('SELECT * FROM dnp_selling_observations').all()
    ) as Array<{
      id: string;
      product_id: string;
      source: string;
      qty: number;
      size2: string;
      pages: number;
      attributes_json: string;
      sell: number;
      vendor_due: number;
      paid_at: string;
      hours_to_deadline: number | null;
      urgency_reliable: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      product_id: r.product_id,
      source: r.source,
      qty: r.qty,
      size2: r.size2,
      pages: r.pages,
      attributes: JSON.parse(r.attributes_json || '{}'),
      sell: r.sell,
      vendor_due: r.vendor_due,
      paid_at: r.paid_at,
      hours_to_deadline: r.hours_to_deadline,
      urgency_reliable: Boolean(r.urgency_reliable),
    }));
  }

  async saveDnpSellingObservations(observations: DnpSellingObservation[]): Promise<void> {
    this.db.exec('DELETE FROM dnp_selling_observations');
    for (const o of observations) {
      await this.addDnpSellingObservation(o);
    }
  }

  async addDnpSellingObservation(obs: DnpSellingObservation): Promise<DnpSellingObservation[]> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO dnp_selling_observations
      (id, product_id, source, qty, size2, pages, attributes_json, sell, vendor_due, paid_at, hours_to_deadline, urgency_reliable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      obs.id,
      obs.product_id || 'saddle-stitched-booklets',
      obs.source,
      obs.qty,
      obs.size2,
      obs.pages,
      JSON.stringify(obs.attributes || { pages: obs.pages }),
      obs.sell,
      obs.vendor_due,
      obs.paid_at,
      obs.hours_to_deadline,
      obs.urgency_reliable ? 1 : 0
    );
    return this.getDnpSellingObservations();
  }

  async getRoute1StandardPrices(productId?: string): Promise<Route1BookletPriceRow[]> {
    const rows = (
      productId
        ? this.db
            .prepare(
              'SELECT product_id, size, quantity, pages, attributes_json, price FROM route1_standard_prices WHERE product_id = ?'
            )
            .all(productId)
        : this.db
            .prepare('SELECT product_id, size, quantity, pages, attributes_json, price FROM route1_standard_prices')
            .all()
    ) as Array<{
      product_id: string;
      size: string;
      quantity: number;
      pages: number;
      attributes_json: string;
      price: number;
    }>;
    return rows.map((r) => ({
      productId: r.product_id,
      size: r.size as BookletSize,
      quantity: r.quantity,
      pages: r.pages,
      attributes: JSON.parse(r.attributes_json || '{}'),
      price: r.price,
    }));
  }

  async saveRoute1StandardPrices(rows: Route1BookletPriceRow[]): Promise<void> {
    this.db.exec('DELETE FROM route1_standard_prices');
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO route1_standard_prices (product_id, size, quantity, pages, attributes_json, price) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const r of rows) {
      stmt.run(
        r.productId || 'saddle-stitched-booklets',
        r.size,
        r.quantity,
        r.pages,
        JSON.stringify(r.attributes || { pages: r.pages }),
        r.price
      );
    }
  }

  async getCourierDistanceBands(): Promise<CourierDistanceBand[]> {
    const rows = this.db
      .prepare('SELECT max, gophr, dnp, label, operational_buffer_hours FROM courier_distance_bands ORDER BY max ASC')
      .all() as Array<{
      max: number;
      gophr: number;
      dnp: number;
      label: string;
      operational_buffer_hours: number;
    }>;
    return rows.map((r) => ({
      max: r.max,
      gophr: r.gophr,
      dnp: r.dnp,
      label: r.label,
      operationalBufferHours: r.operational_buffer_hours,
    }));
  }

  async saveCourierDistanceBands(bands: CourierDistanceBand[]): Promise<void> {
    this.db.exec('DELETE FROM courier_distance_bands');
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO courier_distance_bands (max, gophr, dnp, label, operational_buffer_hours) VALUES (?, ?, ?, ?, ?)'
    );
    for (const b of bands) {
      stmt.run(b.max, b.gophr, b.dnp, b.label, b.operationalBufferHours);
    }
  }

  async getPostcodeDistances(): Promise<PostcodeDistanceMap> {
    const rows = this.db.prepare('SELECT postcode, miles, source FROM postcode_distances').all() as Array<{
      postcode: string;
      miles: number;
      source: string;
    }>;
    const map: PostcodeDistanceMap = {};
    for (const r of rows) {
      map[r.postcode] = { miles: r.miles, source: r.source };
    }
    return map;
  }

  async upsertPostcodeDistance(postcode: string, entry: PostcodeDistanceEntry): Promise<PostcodeDistanceMap> {
    const normalized = postcode.toUpperCase().replace(/\s+/g, '').trim();
    this.db
      .prepare('INSERT OR REPLACE INTO postcode_distances (postcode, miles, source) VALUES (?, ?, ?)')
      .run(normalized, entry.miles, entry.source);
    return this.getPostcodeDistances();
  }
}
