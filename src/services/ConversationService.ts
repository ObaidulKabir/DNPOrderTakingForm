import { IClock } from '../domain/clock.js';
import {
  ConversationChoice,
  ConversationResponse,
  ConversationStepKey,
  OrderSpecification,
  ProductAttributeDefinition,
  ProductDefinition,
  SupplierProductCapability,
} from '../domain/types.js';
import { IDataRepository } from '../repositories/IDataRepository.js';
import { NlpExtractionService } from './NlpExtractionService.js';
import { QuoteEvaluationService } from './QuoteEvaluationService.js';
import { SupplierRoutingService } from './SupplierRoutingService.js';

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] || m)
  );
}

export class ConversationService {
  constructor(
    private readonly repo: IDataRepository,
    private readonly clock: IClock,
    private readonly nlpService: NlpExtractionService,
    private readonly routingService: SupplierRoutingService,
    private readonly evaluationService: QuoteEvaluationService
  ) {}

  async startConversation(
    initialPrompt: string,
    baseSpec?: Partial<OrderSpecification>
  ): Promise<ConversationResponse> {
    const [config, products] = await Promise.all([
      this.repo.getBusinessConfig(),
      this.repo.getProducts(),
    ]);
    const now = this.clock.now();

    const detectedProduct =
      (baseSpec?.productId && products.find((p) => p.id === baseSpec.productId)) ||
      this.nlpService.detectProductFromText(initialPrompt, products);

    const initial = {
      ...this.nlpService.createInitialSpec(config, detectedProduct),
      ...(baseSpec || {}),
    };
    const extracted = this.nlpService.extractFromText(initialPrompt, initial, now, products);
    const activeProduct =
      products.find((p) => p.id === (extracted.productId || 'saddle-stitched-booklets')) ||
      detectedProduct;

    const productLabel =
      activeProduct?.id === 'saddle-stitched-booklets'
        ? 'booklet'
        : activeProduct?.singularName.toLowerCase() || 'print';

    const botMessages: string[] = [
      `Thanks — I'll turn that into a complete ${productLabel} specification. I'll only ask for details that are still missing.`,
    ];

    if (this.evaluationService.quoteInputsComplete(extracted, activeProduct)) {
      const evaluation = await this.evaluationService.evaluate(extracted, true);
      if (evaluation.quoteState.botCompletionMessage) {
        botMessages.push(evaluation.quoteState.botCompletionMessage);
      }
      return {
        spec: extracted,
        currentStep: 'done',
        botMessages,
        choices: [],
        showAttach: extracted.artwork === 'Ready' && !extracted.file,
        evaluation,
      };
    }

    return this.advanceToNextStep(extracted, botMessages);
  }

  private buildQuantityStep(
    spec: OrderSpecification,
    config: Awaited<ReturnType<IDataRepository['getBusinessConfig']>>,
    capabilities: SupplierProductCapability[],
    now: Date
  ): { prompt: string; choices: ConversationChoice[] } {
    const h = this.routingService.hoursLeft(spec, now);
    const mx = this.routingService.maxQtyForHours(h, config, capabilities);
    const arr = this.routingService.getQuantityChoicesForHours(h, config, capabilities);
    const choices: ConversationChoice[] = arr
      .filter((x) => x <= mx)
      .map((x) => ({ label: String(x), value: x }));
    choices.push({ label: 'Custom quantity', value: 'customQty' });
    return { prompt: 'How many copies do you need?', choices };
  }

  private getMissingPreDeadlineAttribute(
    spec: OrderSpecification,
    productDef: ProductDefinition | null
  ): ProductAttributeDefinition | null {
    if (!productDef) return null;
    for (const attr of productDef.attributes) {
      if (attr.compositeGroup === 'stock') continue;
      if (attr.required && !this.nlpService.getSpecAttr(spec, attr.attributeKey)) {
        return attr;
      }
    }
    return null;
  }

  private isCompositeStockMissing(
    spec: OrderSpecification,
    productDef: ProductDefinition | null
  ): boolean {
    if (!productDef || !productDef.stockRecommendation) return false;
    const stockAttrs = productDef.attributes.filter((a) => a.compositeGroup === 'stock');
    return stockAttrs.some((a) => !this.nlpService.getSpecAttr(spec, a.attributeKey));
  }

  async advanceToNextStep(
    specInput: OrderSpecification,
    existingBotMessages: string[] = []
  ): Promise<ConversationResponse> {
    const productId = specInput.productId || 'saddle-stitched-booklets';
    const [config, productDef, capabilities] = await Promise.all([
      this.repo.getBusinessConfig(),
      this.repo.getProductById(productId),
      this.repo.getSupplierCapabilities(productId),
    ]);
    const now = this.clock.now();
    const spec = structuredClone(specInput);
    const botMessages = [...existingBotMessages];
    let choices: ConversationChoice[] = [];
    let currentStep: ConversationStepKey = null;

    const missingPreAttr = this.getMissingPreDeadlineAttribute(spec, productDef);

    if (missingPreAttr) {
      currentStep = missingPreAttr.attributeKey;
      botMessages.push(missingPreAttr.questionPrompt);
      choices = missingPreAttr.quickChoices.map((c) => ({ label: c.label, value: c.value }));
    } else if (!spec.deadline) {
      currentStep = 'deadline';
      botMessages.push(
        'What is the <strong>latest</strong> you need these delivered by? Please give me the day and time, for example “tomorrow by 11am”.'
      );
    } else if (!spec.quantity) {
      currentStep = 'quantity';
      const qStep = this.buildQuantityStep(spec, config, capabilities, now);
      botMessages.push(qStep.prompt);
      choices = qStep.choices;
    } else if (!this.routingService.isValidQuantity(spec, config, now, capabilities)) {
      const h = this.routingService.hoursLeft(spec, now) ?? 0;
      const mx = this.routingService.maxQtyForHours(h, config, capabilities);
      spec.quantity = null;
      botMessages.push(
        `With approximately <strong>${h.toFixed(1)} hours</strong> available, this demo can automatically quote up to <strong>${mx} copies</strong>. Please choose a quantity within that range.`
      );
      currentStep = 'quantity';
      const qStep = this.buildQuantityStep(spec, config, capabilities, now);
      botMessages.push(qStep.prompt);
      choices = qStep.choices;
    } else if (spec.artwork === null) {
      currentStep = 'artwork';
      botMessages.push('Is your artwork print-ready?');
      choices = [
        { label: 'Yes — ready', value: 'ready' },
        { label: 'Not yet', value: 'notready' },
      ];
    } else if (this.isCompositeStockMissing(spec, productDef)) {
      currentStep = 'stock';
      botMessages.push(productDef!.stockRecommendation!.promptHtml);
      choices = [
        { label: 'Yes — use recommended', value: 'recommended' },
        { label: 'Choose another paper', value: 'otherstock' },
      ];
    } else if (!spec.postcode) {
      currentStep = 'postcode';
      botMessages.push('What is the delivery postcode?');
    } else if (!spec.address) {
      currentStep = 'manualAddress';
      botMessages.push(
        'What is the full delivery address? Please type the building number and street or building name.'
      );
    } else if (spec.devMiles == null) {
      currentStep = 'mileage';
      botMessages.push(
        'Approximately how many miles is the delivery address from the production/dispatch point? This is a staging estimate; enter a number such as 3.4.'
      );
    } else if (spec.hotel === null) {
      currentStep = 'hotel';
      botMessages.push('Is the delivery going to a hotel?');
      choices = [
        { label: 'No', value: 'nohotel' },
        { label: 'Yes', value: 'hotel' },
      ];
    } else if (spec.hotel === true && !spec.hotelName) {
      currentStep = 'hotelName';
      botMessages.push(
        "What is the hotel name? We'll use the delivery address and access requirements when checking fulfilment."
      );
    } else {
      currentStep = 'done';
      const evaluation = await this.evaluationService.evaluate(spec, true);
      if (evaluation.quoteState.botCompletionMessage) {
        botMessages.push(evaluation.quoteState.botCompletionMessage);
      }
      return {
        spec,
        currentStep,
        botMessages,
        choices: [],
        showAttach: spec.artwork === 'Ready' && !spec.file,
        evaluation,
      };
    }

    const evaluation = await this.evaluationService.evaluate(spec, false);
    return {
      spec,
      currentStep,
      botMessages,
      choices,
      showAttach: spec.artwork === 'Ready' && !spec.file,
      evaluation,
    };
  }

  async processChoice(
    specInput: OrderSpecification,
    currentStep: ConversationStepKey,
    choiceValue: string | number
  ): Promise<ConversationResponse> {
    const productId = specInput.productId || 'saddle-stitched-booklets';
    const [config, productDef] = await Promise.all([
      this.repo.getBusinessConfig(),
      this.repo.getProductById(productId),
    ]);
    const spec = structuredClone(specInput);

    if (currentStep === 'address') {
      if (choiceValue === 'manualAddress') {
        const evaluation = await this.evaluationService.evaluate(spec, false);
        return {
          spec,
          currentStep: 'manualAddress',
          botMessages: ['Type the full delivery address below.'],
          choices: [],
          showAttach: spec.artwork === 'Ready' && !spec.file,
          evaluation,
        };
      }
      spec.address = String(choiceValue).replace(/^addr:/, '');
    } else if (currentStep === 'pages' && choiceValue === 'typedPages') {
      const evaluation = await this.evaluationService.evaluate(spec, false);
      return {
        spec,
        currentStep: 'pages',
        botMessages: ['Type the page count below.'],
        choices: [],
        showAttach: spec.artwork === 'Ready' && !spec.file,
        evaluation,
      };
    } else if (currentStep === 'quantity') {
      if (choiceValue === 'customQty') {
        const evaluation = await this.evaluationService.evaluate(spec, false);
        return {
          spec,
          currentStep: 'quantity',
          botMessages: ['Type the quantity below.'],
          choices: [],
          showAttach: spec.artwork === 'Ready' && !spec.file,
          evaluation,
        };
      }
      spec.quantity = Number(choiceValue);
    } else if (currentStep === 'artwork') {
      spec.artwork = choiceValue === 'ready' ? 'Ready' : 'Not ready';
    } else if (currentStep === 'stock' && productDef?.stockRecommendation) {
      if (choiceValue === 'recommended') {
        const rec = productDef.stockRecommendation.recommendedValues || {
          cover: config.recommendedCoverStock,
          inner: config.recommendedInnerStock,
        };
        for (const [k, val] of Object.entries(rec)) {
          this.nlpService.setSpecAttr(spec, k, val);
        }
      } else {
        const evaluation = await this.evaluationService.evaluate(spec, false);
        return {
          spec,
          currentStep: 'customstock',
          botMessages: [
            productDef.stockRecommendation.customPromptHtml ||
              'Type the cover and inner stock you would like, for example “250gsm silk cover, 170gsm silk inner”.',
          ],
          choices: [],
          showAttach: spec.artwork === 'Ready' && !spec.file,
          evaluation,
        };
      }
    } else if (currentStep === 'hotel') {
      spec.hotel = choiceValue === 'hotel';
      if (!spec.hotel) spec.hotelName = null;
    } else if (currentStep) {
      // Dynamic product attribute choice (e.g., size, orientation, pages, sides, stock, cassette)
      const attrDef = productDef?.attributes.find((a) => a.attributeKey === currentStep);
      const val = attrDef?.inputType === 'number' ? Number(choiceValue) : String(choiceValue);
      this.nlpService.setSpecAttr(spec, currentStep, val);
    }

    return this.advanceToNextStep(spec);
  }

  async processReply(
    specInput: OrderSpecification,
    currentStep: ConversationStepKey,
    rawReply: string
  ): Promise<ConversationResponse> {
    const productId = specInput.productId || 'saddle-stitched-booklets';
    const [config, productDef, capabilities, products] = await Promise.all([
      this.repo.getBusinessConfig(),
      this.repo.getProductById(productId),
      this.repo.getSupplierCapabilities(productId),
      this.repo.getProducts(),
    ]);
    const now = this.clock.now();
    let spec = structuredClone(specInput);
    const t = rawReply.trim();

    if (currentStep === 'manualAddress') {
      spec.address = t;
    } else if (currentStep === 'deadline') {
      const d = this.nlpService.parseDeadline(t, now);
      if (!d) {
        const evaluation = await this.evaluationService.evaluate(spec, false);
        return {
          spec,
          currentStep: 'deadline',
          botMessages: [
            'Please give me an exact latest time, such as <strong>tomorrow by 11am</strong>. This is important because the price and availability are calculated against that delivery commitment.',
          ],
          choices: [],
          showAttach: spec.artwork === 'Ready' && !spec.file,
          evaluation,
        };
      }
      spec.deadline = d.toISOString();
    } else if (currentStep === 'mileage') {
      const n = Number(t.replace(/\s*(miles?|mi)\s*$/i, '').trim());
      if (!Number.isFinite(n) || n < 0 || n > 1000) {
        const evaluation = await this.evaluationService.evaluate(spec, false);
        return {
          spec,
          currentStep: 'mileage',
          botMessages: ['Please enter an approximate mileage, such as 3.4.'],
          choices: [],
          showAttach: spec.artwork === 'Ready' && !spec.file,
          evaluation,
        };
      }
      spec.devMiles = n;
    } else if (currentStep === 'postcode') {
      const pc = t.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i);
      if (!pc) {
        const evaluation = await this.evaluationService.evaluate(spec, false);
        return {
          spec,
          currentStep: 'postcode',
          botMessages: ['Please enter a UK delivery postcode.'],
          choices: [],
          showAttach: spec.artwork === 'Ready' && !spec.file,
          evaluation,
        };
      }
      spec.postcode = pc[0].toUpperCase();
    } else if (currentStep === 'hotelName') {
      spec.hotelName = t;
    } else if (currentStep === 'quantity') {
      const n = Number(t.replace(/\D/g, ''));
      if (!n) {
        const evaluation = await this.evaluationService.evaluate(spec, false);
        return {
          spec,
          currentStep: 'quantity',
          botMessages: ['Please enter the number of copies.'],
          choices: [],
          showAttach: spec.artwork === 'Ready' && !spec.file,
          evaluation,
        };
      }
      const mx = this.routingService.maxQtyForHours(
        this.routingService.hoursLeft(spec, now),
        config,
        capabilities
      );
      if (n > mx) {
        const evaluation = await this.evaluationService.evaluate(spec, false);
        return {
          spec,
          currentStep: 'quantity',
          botMessages: [
            `That exceeds the automatic quantity limit of <strong>${mx}</strong> for the time available. A larger quantity would need a manual availability check.`,
          ],
          choices: [],
          showAttach: spec.artwork === 'Ready' && !spec.file,
          evaluation,
        };
      }
      spec.quantity = n;
    } else if (currentStep === 'customstock') {
      const a = t.match(/(\d{2,3})\s*gsm(?:\s+\w+)?\s+cover/i);
      const b = t.match(/(\d{2,3})\s*gsm(?:\s+\w+)?\s+inner/i);
      if (!a || !b) {
        const evaluation = await this.evaluationService.evaluate(spec, false);
        return {
          spec,
          currentStep: 'customstock',
          botMessages: ['Please include both, for example <strong>250gsm silk cover, 170gsm silk inner</strong>.'],
          choices: [],
          showAttach: spec.artwork === 'Ready' && !spec.file,
          evaluation,
        };
      }
      this.nlpService.setSpecAttr(spec, 'cover', `${a[1]}gsm Silk`);
      this.nlpService.setSpecAttr(spec, 'inner', `${b[1]}gsm Silk`);
    } else if (currentStep && productDef?.attributes.some((a) => a.attributeKey === currentStep)) {
      const attrDef = productDef.attributes.find((a) => a.attributeKey === currentStep)!;
      const rules = attrDef.validationRules || {};

      if (attrDef.inputType === 'number') {
        const n = Number(t.match(/\d+/)?.[0]);
        if (
          !n ||
          (rules.min != null && n < rules.min) ||
          (rules.max != null && n > rules.max) ||
          (rules.multipleOf != null && n % rules.multipleOf !== 0)
        ) {
          const evaluation = await this.evaluationService.evaluate(spec, false);
          return {
            spec,
            currentStep,
            botMessages: [
              rules.errorMessage ||
                `For this demo, please use a value from ${rules.min ?? 1}–${rules.max ?? 100}.`,
            ],
            choices: [],
            showAttach: spec.artwork === 'Ready' && !spec.file,
            evaluation,
          };
        }
        this.nlpService.setSpecAttr(spec, currentStep, n);
      } else if (rules.allowedValues && rules.allowedValues.length > 0) {
        const matched = rules.allowedValues.find(
          (allowed) =>
            allowed.toLowerCase() === t.toLowerCase() ||
            t.toLowerCase().includes(allowed.toLowerCase().split(' ')[0])
        );
        if (!matched) {
          const evaluation = await this.evaluationService.evaluate(spec, false);
          return {
            spec,
            currentStep,
            botMessages: [rules.errorMessage || `Please choose one of: ${rules.allowedValues.join(', ')}.`],
            choices: [],
            showAttach: spec.artwork === 'Ready' && !spec.file,
            evaluation,
          };
        }
        this.nlpService.setSpecAttr(spec, currentStep, matched);
      } else {
        this.nlpService.setSpecAttr(spec, currentStep, t);
      }
    } else {
      spec = this.nlpService.extractFromText(t, spec, now, products);
    }

    return this.advanceToNextStep(spec);
  }

  async processFileUpload(specInput: OrderSpecification, fileName: string): Promise<ConversationResponse> {
    const spec = structuredClone(specInput);
    spec.file = fileName;
    spec.artwork = 'Ready';
    return this.advanceToNextStep(spec, [`Artwork uploaded: <strong>${esc(fileName)}</strong>.`]);
  }
}
