import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto.js';

const key = randomBytes(32).toString('base64');

describe('token encryption', () => {
  it('round-trips', () => {
    expect(decrypt(encrypt('ghu_example', key), key)).toBe('ghu_example');
  });

  it('uses a fresh IV each time', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('rejects tampered ciphertext', () => {
    const [iv, tag, data] = encrypt('secret', key).split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt([iv, tag, flipped.toString('base64url')].join('.'), key)).toThrow();
  });

  it('rejects the wrong key', () => {
    const other = randomBytes(32).toString('base64');
    expect(() => decrypt(encrypt('secret', key), other)).toThrow();
  });
});
