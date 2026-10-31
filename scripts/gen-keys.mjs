// Prints fresh random secrets to paste into .env.
import { randomBytes } from 'node:crypto';

console.log(`SESSION_SECRET=${randomBytes(32).toString('base64url')}`);
console.log(`TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
