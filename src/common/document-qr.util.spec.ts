import {
  createDocumentQrPayload,
  parseDocumentQrPayload,
} from './document-qr.util';

describe('document QR', () => {
  const previousSecret = process.env.DOCUMENT_QR_SECRET;

  beforeAll(() => {
    process.env.DOCUMENT_QR_SECRET = 'test-document-qr-secret';
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.DOCUMENT_QR_SECRET;
    } else {
      process.env.DOCUMENT_QR_SECRET = previousSecret;
    }
  });

  it('round-trips an invoice code', () => {
    const payload = createDocumentQrPayload('invoice', 'hd-001');
    expect(parseDocumentQrPayload(payload)).toEqual({
      kind: 'invoice',
      code: 'HD-001',
    });
  });

  it('round-trips a consignment code', () => {
    const payload = createDocumentQrPayload('consignment', 'KG-001');
    expect(parseDocumentQrPayload(payload)).toEqual({
      kind: 'consignment',
      code: 'KG-001',
    });
  });

  it('rejects a modified payload', () => {
    const payload = createDocumentQrPayload('invoice', 'HD-001');
    const parts = payload.split('.');
    parts[2] = Buffer.from('HD-002').toString('base64url');
    expect(() => parseDocumentQrPayload(parts.join('.'))).toThrow(
      'Chữ ký QR không hợp lệ',
    );
  });
});
