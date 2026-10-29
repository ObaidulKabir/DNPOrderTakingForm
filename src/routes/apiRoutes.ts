import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../container.js';
import {
  ConversationStepKey,
  OrderSpecification,
  ProductDefinition,
  Route1BookletPriceRow,
  SupplierProductCapability,
} from '../domain/types.js';

export function createApiRouter(container: ServiceContainer): Router {
  const router = Router();
  const { repo, nlpService, evaluationService, conversationService } = container;

  // Initialize / bootstrap default state, multi-product catalog, and UI options
  router.get('/bootstrap', async (req: Request, res: Response) => {
    try {
      const requestedProductId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
      const [config, products] = await Promise.all([
        repo.getBusinessConfig(),
        repo.getProducts(),
      ]);
      const activeProduct =
        products.find((p) => p.id === (requestedProductId || 'saddle-stitched-booklets')) ||
        products[0];

      const initialSpec = nlpService.createInitialSpec(config, activeProduct);
      const evaluation = await evaluationService.evaluate(initialSpec, false);

      res.json({
        config: {
          productName: config.productName,
          allowedSizes: config.allowedSizes,
          allowedOrientations: config.allowedOrientations,
          coverStockOptions: config.coverStockOptions,
          innerStockOptions: config.innerStockOptions,
        },
        products,
        activeProduct,
        initialSpec,
        evaluation,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Admin dashboard overview summary
  router.get('/admin/summary', async (_req: Request, res: Response) => {
    try {
      const [products, capabilities, hrjJobs, dnpObs, route1Rows, bands, postcodes, config] =
        await Promise.all([
          repo.getProducts(),
          repo.getSupplierCapabilities(),
          repo.getHrjHistoricalJobs(),
          repo.getDnpSellingObservations(),
          repo.getRoute1StandardPrices(),
          repo.getCourierDistanceBands(),
          repo.getPostcodeDistances(),
          repo.getBusinessConfig(),
        ]);

      res.json({
        counts: {
          products: products.length,
          activeProducts: products.filter((p) => p.active).length,
          supplierCapabilities: capabilities.length,
          hrjHistoricalJobs: hrjJobs.length,
          dnpSellingObservations: dnpObs.length,
          route1PriceRows: route1Rows.length,
          courierDistanceBands: bands.length,
          verifiedPostcodes: Object.keys(postcodes).length,
        },
        products,
        capabilities,
        config,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Start conversational intake from natural language prompt
  router.post('/conversation/start', async (req: Request, res: Response) => {
    try {
      const { prompt, spec } = req.body as { prompt?: string; spec?: Partial<OrderSpecification> };
      if (!prompt || !String(prompt).trim()) {
        res.status(400).json({ error: 'Prompt is required' });
        return;
      }
      const result = await conversationService.startConversation(String(prompt).trim(), spec);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Process a quick-choice button selection in the conversation
  router.post('/conversation/choice', async (req: Request, res: Response) => {
    try {
      const { spec, currentStep, value } = req.body as {
        spec: OrderSpecification;
        currentStep: ConversationStepKey;
        value: string | number;
      };
      if (!spec) {
        res.status(400).json({ error: 'Specification state is required' });
        return;
      }
      const result = await conversationService.processChoice(spec, currentStep ?? null, value);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Process a free-text user reply in the conversation
  router.post('/conversation/reply', async (req: Request, res: Response) => {
    try {
      const { spec, currentStep, text } = req.body as {
        spec: OrderSpecification;
        currentStep: ConversationStepKey;
        text: string;
      };
      if (!spec || typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ error: 'Specification and non-empty reply text are required' });
        return;
      }
      const result = await conversationService.processReply(spec, currentStep ?? null, text);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Process artwork file attachment metadata in the conversation
  router.post('/conversation/upload', async (req: Request, res: Response) => {
    try {
      const { spec, fileName } = req.body as { spec: OrderSpecification; fileName: string };
      if (!spec || !fileName) {
        res.status(400).json({ error: 'Specification and fileName are required' });
        return;
      }
      const result = await conversationService.processFileUpload(spec, fileName);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Evaluate specification directly (e.g. when sidebar inputs are edited)
  router.post('/quote/evaluate', async (req: Request, res: Response) => {
    try {
      const { spec, triggerQuote } = req.body as {
        spec: OrderSpecification;
        triggerQuote?: boolean;
      };
      if (!spec) {
        res.status(400).json({ error: 'Specification is required' });
        return;
      }
      const evaluation = await evaluationService.evaluate(spec, Boolean(triggerQuote));
      res.json(evaluation);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- MULTI-PRODUCT CATALOG & CAPABILITIES ENDPOINTS ----

  router.get('/data/products', async (_req: Request, res: Response) => {
    try {
      res.json(await repo.getProducts());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/data/products/:id', async (req: Request, res: Response) => {
    try {
      const prod = await repo.getProductById(String(req.params.id));
      if (!prod) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }
      res.json(prod);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/data/products', async (req: Request, res: Response) => {
    try {
      const body = req.body as ProductDefinition;
      if (!body || !body.id || !body.name) {
        res.status(400).json({ error: 'Product id and name are required' });
        return;
      }
      const saved = await repo.upsertProduct(body);
      res.status(201).json(saved);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/data/products/:id', async (req: Request, res: Response) => {
    try {
      const body = { ...(req.body as ProductDefinition), id: String(req.params.id) };
      const saved = await repo.upsertProduct(body);
      res.json(saved);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/data/supplier-capabilities', async (req: Request, res: Response) => {
    try {
      const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
      res.json(await repo.getSupplierCapabilities(productId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/data/supplier-capabilities', async (req: Request, res: Response) => {
    try {
      const body = req.body as SupplierProductCapability;
      if (!body || !body.supplierId || !body.productId) {
        res.status(400).json({ error: 'supplierId and productId are required' });
        return;
      }
      const saved = await repo.upsertSupplierCapability(body);
      res.status(201).json(saved);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- DYNAMIC DATA SOURCE MANAGEMENT ENDPOINTS ----

  router.get('/data/business-config', async (_req: Request, res: Response) => {
    try {
      res.json(await repo.getBusinessConfig());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/data/business-config', async (req: Request, res: Response) => {
    try {
      const updated = await repo.updateBusinessConfig(req.body);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/data/hrj-jobs', async (req: Request, res: Response) => {
    try {
      const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
      res.json(await repo.getHrjHistoricalJobs(productId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/data/hrj-jobs', async (req: Request, res: Response) => {
    try {
      const updated = await repo.addHrjHistoricalJob(req.body);
      res.status(201).json(updated);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/data/hrj-jobs/:orderId', async (req: Request, res: Response) => {
    try {
      const orderId = String(req.params.orderId);
      const all = await repo.getHrjHistoricalJobs();
      const filtered = all.filter((j) => j.order_id !== orderId);
      await repo.saveHrjHistoricalJobs(filtered);
      res.json(filtered);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/data/hrj-jobs', async (req: Request, res: Response) => {
    try {
      if (!Array.isArray(req.body)) {
        res.status(400).json({ error: 'Expected array of HRJ historical jobs' });
        return;
      }
      await repo.saveHrjHistoricalJobs(req.body);
      res.json(await repo.getHrjHistoricalJobs());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/data/dnp-selling', async (req: Request, res: Response) => {
    try {
      const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
      res.json(await repo.getDnpSellingObservations(productId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/data/dnp-selling', async (req: Request, res: Response) => {
    try {
      const updated = await repo.addDnpSellingObservation(req.body);
      res.status(201).json(updated);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/data/dnp-selling/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const all = await repo.getDnpSellingObservations();
      const filtered = all.filter((o) => o.id !== id);
      await repo.saveDnpSellingObservations(filtered);
      res.json(filtered);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/data/dnp-selling', async (req: Request, res: Response) => {
    try {
      if (!Array.isArray(req.body)) {
        res.status(400).json({ error: 'Expected array of DNP selling observations' });
        return;
      }
      await repo.saveDnpSellingObservations(req.body);
      res.json(await repo.getDnpSellingObservations());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/data/route1-prices', async (req: Request, res: Response) => {
    try {
      const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
      res.json(await repo.getRoute1StandardPrices(productId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/data/route1-prices', async (req: Request, res: Response) => {
    try {
      const row = req.body as Route1BookletPriceRow;
      if (!row || !row.size || !row.quantity || row.price == null) {
        res.status(400).json({ error: 'size, quantity, and price are required' });
        return;
      }
      const all = await repo.getRoute1StandardPrices();
      const productId = row.productId || 'saddle-stitched-booklets';
      const pages = Number(row.pages || 0);
      const filtered = all.filter(
        (r) =>
          !(
            (r.productId || 'saddle-stitched-booklets') === productId &&
            r.size === row.size &&
            r.quantity === Number(row.quantity) &&
            r.pages === pages
          )
      );
      filtered.push({
        productId,
        size: row.size,
        quantity: Number(row.quantity),
        pages,
        attributes: row.attributes || { pages },
        price: Number(row.price),
      });
      await repo.saveRoute1StandardPrices(filtered);
      res.status(201).json(await repo.getRoute1StandardPrices(productId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/data/route1-prices', async (req: Request, res: Response) => {
    try {
      if (!Array.isArray(req.body)) {
        res.status(400).json({ error: 'Expected array of Route1 price rows' });
        return;
      }
      await repo.saveRoute1StandardPrices(req.body);
      res.json(await repo.getRoute1StandardPrices());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/data/distance-bands', async (_req: Request, res: Response) => {
    try {
      res.json(await repo.getCourierDistanceBands());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/data/distance-bands', async (req: Request, res: Response) => {
    try {
      if (!Array.isArray(req.body)) {
        res.status(400).json({ error: 'Expected array of distance bands' });
        return;
      }
      await repo.saveCourierDistanceBands(req.body);
      res.json(await repo.getCourierDistanceBands());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/data/postcodes', async (_req: Request, res: Response) => {
    try {
      res.json(await repo.getPostcodeDistances());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/data/postcodes', async (req: Request, res: Response) => {
    try {
      const { postcode, miles, source } = req.body as {
        postcode?: string;
        miles?: number;
        source?: string;
      };
      if (!postcode || typeof miles !== 'number') {
        res.status(400).json({ error: 'postcode and numeric miles are required' });
        return;
      }
      const updated = await repo.upsertPostcodeDistance(postcode, {
        miles,
        source: source || 'dynamic API entry',
      });
      res.status(201).json(updated);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
