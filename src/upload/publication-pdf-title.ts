import { ParseSpeeds, PDFDocument } from 'pdf-lib';
import { repairUploadedFilename } from '../common/uploaded-filename.util';

const STORED_PUBLICATION_PDF =
  /^\/uploads\/products\/cong-bo\/(\d+-[a-f0-9]{16}\.pdf)$/;

/**
 * Chrome hiện tên trên thanh PDF bằng /Title. Không có Title thì nó lấy
 * đoạn cuối URL — đúng tên file ngẫu nhiên đang lưu trên đĩa.
 */
export function matchPublicationPdfRequest(
  method: string,
  path: string,
): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const pathname = (path || '').split('?')[0];
  const match = STORED_PUBLICATION_PDF.exec(pathname);
  return match ? match[1] : null;
}

export function publicationDisplayName(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const repaired = repairUploadedFilename(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  if (!repaired) return null;
  return repaired.length > 240 ? repaired.slice(0, 240).trim() : repaired;
}

export function selectPublicationDisplayName(
  values: Array<string | null | undefined>,
): string | null {
  const names = values
    .map((value) => publicationDisplayName(value))
    .filter((value): value is string => Boolean(value));

  return (
    names.sort((left, right) => {
      const unicodeScore = countNonAscii(right) - countNonAscii(left);
      if (unicodeScore !== 0) return unicodeScore;
      return right.length - left.length;
    })[0] ?? null
  );
}

export function contentDispositionInline(filename: string): string {
  const cleaned = filename.replace(/["\\]/g, ' ').trim() || 'document.pdf';
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function stampPdfTitle(
  bytes: Uint8Array,
  title: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
    parseSpeed: ParseSpeeds.Fast,
  });
  if (pdf.isEncrypted) {
    throw new Error('encrypted pdf');
  }
  pdf.setTitle(title, { showInWindowTitleBar: true });
  return pdf.save({ useObjectStreams: false });
}

function countNonAscii(value: string): number {
  return Array.from(value).filter((char) => char.charCodeAt(0) > 0x7f).length;
}
