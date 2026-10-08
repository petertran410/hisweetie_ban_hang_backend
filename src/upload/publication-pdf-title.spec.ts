import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import { Request, Response } from 'express';
import { createPublicationPdfMiddleware } from './publication-pdf.middleware';
import {
  contentDispositionInline,
  matchPublicationPdfRequest,
  publicationDisplayName,
  selectPublicationDisplayName,
  stampPdfTitle,
} from './publication-pdf-title';

const STORED_NAME = '1790786495645-3225607dc874a687.pdf';
const ORIGINAL_NAME = '06LM - Bột thach thủy tinh (trong nước) (1).pdf';

describe('publication pdf title', () => {
  it('only matches the stored publication pdf url', () => {
    expect(
      matchPublicationPdfRequest(
        'GET',
        `/uploads/products/cong-bo/${STORED_NAME}`,
      ),
    ).toBe(STORED_NAME);
    expect(
      matchPublicationPdfRequest(
        'GET',
        `/uploads/products/cong-bo/${STORED_NAME}?download=1`,
      ),
    ).toBe(STORED_NAME);
    expect(
      matchPublicationPdfRequest(
        'POST',
        `/uploads/products/cong-bo/${STORED_NAME}`,
      ),
    ).toBe(null);
    expect(
      matchPublicationPdfRequest(
        'GET',
        '/uploads/products/cong-bo/../secret.pdf',
      ),
    ).toBeNull();
    expect(
      matchPublicationPdfRequest('GET', '/api/products/35/documents/658/view'),
    ).toBeNull();
  });

  it('repairs a latin-1 misread of the original unicode name', () => {
    const nfdName = `06LM - ${'Bột'.normalize('NFD')} thạch.pdf`;
    const mojibake = Buffer.from(nfdName, 'utf8').toString('latin1');

    expect(publicationDisplayName(mojibake)).toBe('06LM - Bột thạch.pdf');
    expect(publicationDisplayName('   ')).toBeNull();
  });

  it('preserves the ASCII part of the stored original name', () => {
    const mojibake = '06LM - BoÌ£Ìt thach thuÌy tinh (trong nuÌoÌÌc) (1).pdf';

    expect(publicationDisplayName(mojibake)).toBe(ORIGINAL_NAME);
  });

  it('prefers the complete Unicode name when one URL has duplicate rows', () => {
    expect(
      selectPublicationDisplayName([
        '06LM - BoÌ£Ìt thach thuÌy tinh (trong nuÌoÌÌc) (1).pdf',
        '06LM - BoÌ£Ìt thaÌ£ch thuÌy tinh (trong nuÌoÌÌc) (1).pdf',
      ]),
    ).toBe('06LM - Bột thạch thủy tinh (trong nước) (1).pdf');
  });

  it('stamps the pdf title without adding pages', async () => {
    const source = await PDFDocument.create();
    source.addPage();
    const stamped = await stampPdfTitle(await source.save(), ORIGINAL_NAME);
    const reloaded = await PDFDocument.load(stamped);

    expect(reloaded.getTitle()).toBe(ORIGINAL_NAME);
    expect(reloaded.getPageCount()).toBe(1);
    expect(Buffer.from(stamped.subarray(0, 5)).toString('utf8')).toBe('%PDF-');
  });

  it('puts the unicode name in the inline content disposition', () => {
    const header = contentDispositionInline(ORIGINAL_NAME);

    expect(header.startsWith('inline;')).toBe(true);
    expect(header).toContain("filename*=UTF-8''06LM%20-%20B%E1%BB%99t");
    expect(header).not.toContain('Bột');
  });
});

describe('publication pdf middleware', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'publication-pdf-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeStoredPdf() {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await writeFile(join(directory, STORED_NAME), await pdf.save());
  }

  function invoke(
    findOriginalName: (storedFilename: string) => Promise<string | null>,
    method: 'GET' | 'HEAD' | 'POST',
    path: string,
  ) {
    const middleware = createPublicationPdfMiddleware({
      directory,
      findOriginalName,
    });
    const headers: Record<string, string | number> = {};
    let body: Buffer | undefined;
    let statusCode: number | undefined;
    const state = { headersSent: false, writableEnded: false };

    return new Promise<{
      nexted: boolean;
      headers: Record<string, string | number>;
      body?: Buffer;
      statusCode?: number;
    }>((resolve, reject) => {
      const req = { method, path } as Request;
      const res = {
        get headersSent() {
          return state.headersSent;
        },
        get writableEnded() {
          return state.writableEnded;
        },
        setHeader(name: string, value: string | number) {
          headers[name.toLowerCase()] = value;
        },
        status(code: number) {
          statusCode = code;
          return this;
        },
        end(chunk?: Buffer) {
          body = chunk ? Buffer.from(chunk) : undefined;
          state.headersSent = true;
          state.writableEnded = true;
          resolve({ nexted: false, headers, body, statusCode });
        },
      } as unknown as Response;

      void middleware(req, res, (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ nexted: true, headers, body, statusCode });
      }).catch(reject);
    });
  }

  it('serves the same stored file with the original name as its title', async () => {
    await writeStoredPdf();
    const result = await invoke(
      async () => ORIGINAL_NAME,
      'GET',
      `/uploads/products/cong-bo/${STORED_NAME}`,
    );

    expect(result.nexted).toBe(false);
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('application/pdf');
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(String(result.headers['content-disposition'])).toContain(
      'filename*=UTF-8',
    );
    const reloaded = await PDFDocument.load(result.body!);
    expect(reloaded.getTitle()).toBe(ORIGINAL_NAME);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it('repairs a mojibake name before stamping', async () => {
    await writeStoredPdf();
    const mojibake = Buffer.from(ORIGINAL_NAME, 'utf8').toString('latin1');
    const result = await invoke(
      async () => mojibake,
      'GET',
      `/uploads/products/cong-bo/${STORED_NAME}`,
    );

    const reloaded = await PDFDocument.load(result.body!);
    expect(reloaded.getTitle()).toBe(ORIGINAL_NAME);
  });

  it('leaves the static handler to serve a file without an original name', async () => {
    await writeStoredPdf();
    let lookups = 0;
    const result = await invoke(
      async () => {
        lookups += 1;
        return null;
      },
      'GET',
      `/uploads/products/cong-bo/${STORED_NAME}`,
    );

    expect(lookups).toBe(1);
    expect(result.nexted).toBe(true);
    expect(result.body).toBeUndefined();
  });

  it('does not look up unrelated uploads', async () => {
    let lookups = 0;
    const result = await invoke(
      async () => {
        lookups += 1;
        return ORIGINAL_NAME;
      },
      'GET',
      '/uploads/products/images/1790786495645-3225607dc874a687.jpg',
    );

    expect(lookups).toBe(0);
    expect(result.nexted).toBe(true);
  });

  it('falls through when the stored bytes are not a readable pdf', async () => {
    await writeFile(join(directory, STORED_NAME), Buffer.from('not a pdf'));
    const result = await invoke(
      async () => ORIGINAL_NAME,
      'GET',
      `/uploads/products/cong-bo/${STORED_NAME}`,
    );

    expect(result.nexted).toBe(true);
  });

  it('answers HEAD with the stamped length and no body', async () => {
    await writeStoredPdf();
    const result = await invoke(
      async () => ORIGINAL_NAME,
      'HEAD',
      `/uploads/products/cong-bo/${STORED_NAME}`,
    );

    expect(result.nexted).toBe(false);
    expect(result.body).toBeUndefined();
    expect(Number(result.headers['content-length'])).toBeGreaterThan(0);
  });
});
