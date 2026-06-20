import { createHash } from 'node:crypto';

function normalizeText(value: string): string {
  return value.normalize('NFKC');
}

export function sha256Text(value: string): string {
  return createHash('sha256')
    .update(Buffer.from(normalizeText(value), 'utf8'))
    .digest('hex');
}
