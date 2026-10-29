import { IClock, SystemClock } from './domain/clock.js';
import { IDataRepository } from './repositories/IDataRepository.js';
import { JsonCsvDataRepository } from './repositories/JsonCsvDataRepository.js';
import { ConversationService } from './services/ConversationService.js';
import { CourierService } from './services/CourierService.js';
import { NlpExtractionService } from './services/NlpExtractionService.js';
import { PricingService } from './services/PricingService.js';
import { QuoteEvaluationService } from './services/QuoteEvaluationService.js';
import { ResilienceService } from './services/ResilienceService.js';
import { RfcForecastService } from './services/RfcForecastService.js';
import { SupplierRoutingService } from './services/SupplierRoutingService.js';

export interface ServiceContainer {
  repo: IDataRepository;
  clock: IClock;
  nlpService: NlpExtractionService;
  routingService: SupplierRoutingService;
  rfcService: RfcForecastService;
  courierService: CourierService;
  resilienceService: ResilienceService;
  pricingService: PricingService;
  evaluationService: QuoteEvaluationService;
  conversationService: ConversationService;
}

export function createContainer(
  repo: IDataRepository = new JsonCsvDataRepository(),
  clock: IClock = new SystemClock()
): ServiceContainer {
  const nlpService = new NlpExtractionService();
  const routingService = new SupplierRoutingService();
  const rfcService = new RfcForecastService();
  const courierService = new CourierService();
  const resilienceService = new ResilienceService(routingService);
  const pricingService = new PricingService(routingService);
  const evaluationService = new QuoteEvaluationService(
    repo,
    clock,
    routingService,
    rfcService,
    courierService,
    resilienceService,
    pricingService
  );
  const conversationService = new ConversationService(
    repo,
    clock,
    nlpService,
    routingService,
    evaluationService
  );

  return {
    repo,
    clock,
    nlpService,
    routingService,
    rfcService,
    courierService,
    resilienceService,
    pricingService,
    evaluationService,
    conversationService,
  };
}
