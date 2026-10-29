import { beforeEach, describe, expect, it } from 'vitest';
import { createContainer, ServiceContainer } from '../../src/container.js';
import { FixedClock } from '../../src/domain/clock.js';
import { InMemoryDataRepository } from '../../src/repositories/InMemoryDataRepository.js';
import { JsonCsvDataRepository } from '../../src/repositories/JsonCsvDataRepository.js';

describe('ConversationService Full State Machine & Validation Coverage', () => {
  let container: ServiceContainer;
  let clock: FixedClock;

  beforeEach(async () => {
    const fileRepo = new JsonCsvDataRepository();
    const memoryRepo = await InMemoryDataRepository.fromRepository(fileRepo);
    clock = new FixedClock(new Date(2026, 9, 29, 14, 0, 0));
    container = createContainer(memoryRepo, clock);
  });

  it('walks through the entire booklet conversational flow from empty spec to completed quote, including validation errors', async () => {
    const { conversationService } = container;

    // 1. Start with minimal prompt that doesn't specify size
    let res = await conversationService.startConversation('I need some booklets printed');
    expect(res.currentStep).toBe('size');

    // Invalid reply to size
    res = await conversationService.processReply(res.spec, res.currentStep, 'A3 invalid');
    expect(res.currentStep).toBe('size');
    expect(res.botMessages[0]).toContain('Please choose A5 or A4');

    // Valid choice for size
    res = await conversationService.processChoice(res.spec, res.currentStep, 'A4');
    expect(res.spec.size).toBe('A4');
    expect(res.currentStep).toBe('orientation');

    // Invalid reply to orientation
    res = await conversationService.processReply(res.spec, res.currentStep, 'diagonal');
    expect(res.currentStep).toBe('orientation');

    // Valid reply to orientation
    res = await conversationService.processReply(res.spec, res.currentStep, 'Portrait');
    expect(res.spec.orientation).toBe('Portrait');
    expect(res.currentStep).toBe('pages');

    // Choose 'typedPages'
    res = await conversationService.processChoice(res.spec, res.currentStep, 'typedPages');
    expect(res.currentStep).toBe('pages');
    expect(res.botMessages[0]).toContain('Type the page count below');

    // Invalid page count (not multiple of 4)
    res = await conversationService.processReply(res.spec, res.currentStep, '15 pages');
    expect(res.currentStep).toBe('pages');
    expect(res.botMessages[0]).toContain('multiples of 4');

    // Valid page count
    res = await conversationService.processReply(res.spec, res.currentStep, '24');
    expect(res.spec.pages).toBe(24);
    expect(res.currentStep).toBe('deadline');

    // Invalid deadline
    res = await conversationService.processReply(res.spec, res.currentStep, 'sometime soon');
    expect(res.currentStep).toBe('deadline');
    expect(res.botMessages[0]).toContain('exact latest time');

    // Valid deadline (tomorrow by 3pm -> 25h away -> maxQty = 200)
    res = await conversationService.processReply(res.spec, res.currentStep, 'tomorrow by 3pm');
    expect(res.spec.deadline).toBeTruthy();
    expect(res.currentStep).toBe('quantity');

    // Choose 'customQty'
    res = await conversationService.processChoice(res.spec, res.currentStep, 'customQty');
    expect(res.currentStep).toBe('quantity');

    // Non-numeric quantity
    res = await conversationService.processReply(res.spec, res.currentStep, 'lots');
    expect(res.currentStep).toBe('quantity');
    expect(res.botMessages[0]).toContain('Please enter the number of copies');

    // Quantity exceeding limit (>200 for 25h)
    res = await conversationService.processReply(res.spec, res.currentStep, '450');
    expect(res.currentStep).toBe('quantity');
    expect(res.botMessages[0]).toContain('exceeds the automatic quantity limit');

    // Valid quantity
    res = await conversationService.processReply(res.spec, res.currentStep, '100');
    expect(res.spec.quantity).toBe(100);
    expect(res.currentStep).toBe('artwork');

    // Choose artwork ready
    res = await conversationService.processChoice(res.spec, res.currentStep, 'ready');
    expect(res.spec.artwork).toBe('Ready');
    expect(res.showAttach).toBe(true);
    expect(res.currentStep).toBe('stock');

    // Choose custom stock ('otherstock')
    res = await conversationService.processChoice(res.spec, res.currentStep, 'otherstock');
    expect(res.currentStep).toBe('customstock');

    // Invalid custom stock reply
    res = await conversationService.processReply(res.spec, res.currentStep, 'thick paper');
    expect(res.currentStep).toBe('customstock');
    expect(res.botMessages[0]).toContain('Please include both');

    // Valid custom stock reply
    res = await conversationService.processReply(
      res.spec,
      res.currentStep,
      '250gsm silk cover, 130gsm silk inner'
    );
    expect(res.spec.cover).toBe('250gsm Silk');
    expect(res.spec.inner).toBe('130gsm Silk');
    expect(res.currentStep).toBe('postcode');

    // Invalid postcode
    res = await conversationService.processReply(res.spec, res.currentStep, '12345');
    expect(res.currentStep).toBe('postcode');
    expect(res.botMessages[0]).toContain('UK delivery postcode');

    // Valid postcode
    res = await conversationService.processReply(res.spec, res.currentStep, 'E1 3NL');
    expect(res.spec.postcode).toBe('E1 3NL');
    expect(res.currentStep).toBe('manualAddress');

    // Test address choice helper ('manualAddress' and 'addr:...')
    res = await conversationService.processChoice(res.spec, 'address', 'manualAddress');
    expect(res.currentStep).toBe('manualAddress');
    res = await conversationService.processChoice(res.spec, 'address', 'addr:12 High Street, E1 3NL');
    expect(res.spec.address).toBe('12 High Street, E1 3NL');
    expect(res.currentStep).toBe('mileage');

    // Invalid mileage
    res = await conversationService.processReply(res.spec, res.currentStep, 'far away');
    expect(res.currentStep).toBe('mileage');
    expect(res.botMessages[0]).toContain('approximate mileage');

    // Valid mileage
    res = await conversationService.processReply(res.spec, res.currentStep, '3.4 miles');
    expect(res.spec.devMiles).toBe(3.4);
    expect(res.currentStep).toBe('hotel');

    // Choose hotel = Yes
    res = await conversationService.processChoice(res.spec, res.currentStep, 'hotel');
    expect(res.spec.hotel).toBe(true);
    expect(res.currentStep).toBe('hotelName');

    // Provide hotel name -> completes flow and triggers quote!
    res = await conversationService.processReply(res.spec, res.currentStep, 'The Savoy');
    expect(res.spec.hotelName).toBe('The Savoy');
    expect(res.currentStep).toBe('done');
    expect(res.evaluation.quoteState.mode).toBe('quote');

    // Upload artwork file (also exercises HTML escaping)
    const uploadRes = await conversationService.processFileUpload(res.spec, 'brochure_<final>.pdf');
    expect(uploadRes.spec.file).toBe('brochure_<final>.pdf');
    expect(uploadRes.botMessages[0]).toContain('brochure_&lt;final&gt;.pdf');
  });

  it('resets quantity and re-asks when initial prompt has quantity exceeding deadline turnaround limit', async () => {
    const { conversationService } = container;
    // 500 copies for tomorrow 10am (20h away -> max 100 copies)
    const res = await conversationService.startConversation(
      '500 copies, A4 portrait, 20 pages, tomorrow by 10am'
    );
    expect(res.currentStep).toBe('quantity');
    expect(res.spec.quantity).toBeNull();
    expect(res.botMessages.some((m) => m.includes('can automatically quote up to'))).toBe(true);
  });

  it('applies recommended stock, skips hotel, and quotes; also covers not-ready artwork and free-text size', async () => {
    const { conversationService } = container;

    let res = await conversationService.startConversation('I need booklets', {
      productId: 'saddle-stitched-booklets',
    });
    expect(res.currentStep).toBe('size');

    res = await conversationService.processReply(res.spec, 'size', 'A4 please');
    expect(res.spec.size).toBe('A4');
    expect(res.currentStep).toBe('orientation');

    res = await conversationService.processChoice(res.spec, 'orientation', 'Portrait');
    res = await conversationService.processChoice(res.spec, 'pages', 16);
    expect(res.spec.pages).toBe(16);
    expect(res.currentStep).toBe('deadline');

    res = await conversationService.processReply(res.spec, 'deadline', 'tomorrow by 4pm');
    res = await conversationService.processChoice(res.spec, 'quantity', 50);
    expect(res.spec.quantity).toBe(50);

    res = await conversationService.processChoice(res.spec, 'artwork', 'notready');
    expect(res.spec.artwork).toBe('Not ready');
    expect(res.currentStep).toBe('stock');

    res = await conversationService.processChoice(res.spec, 'stock', 'recommended');
    expect(res.spec.cover).toBe('350gsm Silk');
    expect(res.spec.inner).toBe('170gsm Silk');
    expect(res.currentStep).toBe('postcode');

    res = await conversationService.processReply(res.spec, 'postcode', 'E1 3NL');
    res = await conversationService.processReply(res.spec, 'manualAddress', '39 Solent House');
    res = await conversationService.processReply(res.spec, 'mileage', '3.4');
    res = await conversationService.processChoice(res.spec, 'hotel', 'nohotel');
    expect(res.spec.hotel).toBe(false);
    expect(res.spec.hotelName).toBeNull();
    expect(res.currentStep).toBe('done');
    expect(res.evaluation.quoteState.mode).toBe('quote');

    const fallback = await conversationService.processReply(res.spec, null, 'needed by tomorrow 11am');
    expect(fallback.spec.deadline).toBeTruthy();
  });
});
