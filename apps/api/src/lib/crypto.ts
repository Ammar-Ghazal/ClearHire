// AES-256-GCM for GitHub tokens at rest (R-3.3). Output: base64url(iv).base64url(tag).base64url(data)
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encrypt(plain: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(token: string, keyBase64: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed ciphertext');
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
