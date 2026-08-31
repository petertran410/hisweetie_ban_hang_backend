import { BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export type DocumentQrKind = 'invoice' | 'consignment';

const VERSION = 'DT1';
const KEY_ID = 'k1';

function getSecret(): string {
  const secret = process.env.DOCUMENT_QR_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('DOCUMENT_QR_SECRET or JWT_SECRET is required');
  }
  return secret;
}

function typeCode(kind: DocumentQrKind): 'I' | 'C' {
  return kind === 'invoice' ? 'I' : 'C';
}

function signature(value: string): string {
  return createHmac('sha256', getSecret())
    .update(value)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

export function createDocumentQrPayload(
  kind: DocumentQrKind,
  code: string,
): string {
  const normalizedCode = code.trim().toUpperCase();
  const encodedCode = Buffer.from(normalizedCode).toString('base64url');
  const body = `${VERSION}.${typeCode(kind)}.${encodedCode}.${KEY_ID}`;
  return `${body}.${signature(body)}`;
}

export function parseDocumentQrPayload(payload: string): {
  kind: DocumentQrKind;
  code: string;
} {
  const parts = payload.trim().split('.');
  if (parts.length !== 5) throw new BadRequestException('Mã QR không hợp lệ');

  const [version, type, encodedCode, keyId, providedSignature] = parts;
  if (
    version !== VERSION ||
    keyId !== KEY_ID ||
    !['I', 'C'].includes(type) ||
    !encodedCode ||
    encodedCode.length > 200
  ) {
    throw new BadRequestException('Mã QR không được hỗ trợ');
  }

  const body = `${version}.${type}.${encodedCode}.${keyId}`;
  const expected = Buffer.from(signature(body));
  const provided = Buffer.from(providedSignature);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    throw new BadRequestException('Chữ ký QR không hợp lệ');
  }

  let code: string;
  try {
    code = Buffer.from(encodedCode, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestException('Mã QR không hợp lệ');
  }
  if (!code || code.length > 150) {
    throw new BadRequestException('Mã QR không hợp lệ');
  }

  return {
    kind: type === 'I' ? 'invoice' : 'consignment',
    code,
  };
}
