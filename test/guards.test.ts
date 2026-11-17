import { describe, expect, it } from 'vitest';
import { codeLikeReason, withTag } from '../src/guards.js';

describe('safety rule 5: code-like text', () => {
  const blocked = [
    '123456',
    '1234',
    '482',
    '123 456',
    '1 2 3 4 5 6',
    '12-34-56',
    '+91 98765',
    '123456.',
    '4821!',
    'my otp is 482913',
    'CVV: 123',
    'cvc 4321',
    'PIN 1234',
    'the verification code: 99 88 77',
    'Security code is 123',
    'Use passcode 5566 to continue',
    'el código es 4455',
    'Enter 772341 as the code',
    '2FA 445566',
  ];
  for (const text of blocked)
    it(`blocks "${text}"`, () => {
      expect(codeLikeReason(text)).not.toBeNull();
    });

  const allowed = [
    'budget 5000 rupees, 2 people, Dec 20',
    'New task: open news.ycombinator.com and tell me the titles of the top 3 stories.',
    'Find flights for 2 adults on 2026-12-20 under 25000 INR',
    'New task: check the HTTP status code of example.com and report it',
    'Book a table for 4 at 8pm',
    '12',
    'Yes, the second option',
    'Compare prices for the Sony WH-1000XM6 on Amazon.in and Flipkart.',
  ];
  for (const text of allowed)
    it(`allows "${text}"`, () => {
      expect(codeLikeReason(text)).toBeNull();
    });
});

describe('safety rule 6: tag', () => {
  it('puts the tag in front', () => {
    expect(withTag('hello', '[via Claude] ')).toBe('[via Claude] hello');
  });
  it('refuses an empty tag', () => {
    expect(() => withTag('hello', '')).toThrow();
    expect(() => withTag('hello', '  ')).toThrow();
  });
});
