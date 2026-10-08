import { PrismaClient } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { randomUUID } from 'crypto';
import { readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { basename, join, relative, resolve, sep } from 'path';
import {
  selectPublicationDisplayName,
  stampPdfTitle,
} from '../src/upload/publication-pdf-title';

const prisma = new PrismaClient();
const uploadsRoot = resolve(
  process.env.UPLOADS_ROOT || join(process.cwd(), 'uploads'),
);
const publicationRoot = resolve(uploadsRoot, 'products', 'cong-bo');

interface PublicationRow {
  id: number;
  url: string;
  originalName: string | null;
  mimetype: string | null;
}

interface PublicationFile {
  filePath: string;
  rows: PublicationRow[];
}

interface Options {
  apply: boolean;
  limit?: number;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const rows = await prisma.productDocument.findMany({
    where: {
      url: {
        contains: '/uploads/products/cong-bo/',
      },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      url: true,
      originalName: true,
      mimetype: true,
    },
  });

  const files = groupPublicationFiles(rows);
  const targets = options.limit ? files.slice(0, options.limit) : files;
  const mode = options.apply ? 'APPLY' : 'DRY-RUN';
  let updated = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;

  console.log(
    `[publication-pdf-metadata] mode=${mode} files=${targets.length}/${files.length}`,
  );

  for (const target of targets) {
    const displayName = selectPublicationDisplayName(
      target.rows.map((row) => row.originalName),
    );
    if (!displayName) {
      skipped++;
      console.log(
        `SKIP no originalName file=${basename(target.filePath)} rows=${target.rows
          .map((row) => row.id)
          .join(',')}`,
      );
      continue;
    }

    try {
      await stat(target.filePath);
      const input = await readFile(target.filePath);
      const currentTitle = await readPdfTitle(input);
      if (currentTitle?.normalize('NFC') === displayName.normalize('NFC')) {
        skipped++;
        console.log(`SKIP already-correct file=${basename(target.filePath)}`);
        continue;
      }

      const names = target.rows
        .map((row) => row.originalName)
        .filter((name): name is string => Boolean(name));
      const duplicateNote =
        new Set(names.map((name) => name.normalize('NFC'))).size > 1
          ? ` duplicateNames=${JSON.stringify(names)}`
          : '';

      if (!options.apply) {
        console.log(
          `WOULD_UPDATE file=${basename(target.filePath)} title=${JSON.stringify(
            displayName,
          )}${duplicateNote}`,
        );
        updated++;
        continue;
      }

      const output = await stampPdfTitle(input, displayName);
      const temporaryPath = `${target.filePath}.metadata-${process.pid}-${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, output, { flag: 'wx' });
        await rename(temporaryPath, target.filePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }

      updated++;
      console.log(
        `UPDATED file=${basename(target.filePath)} title=${JSON.stringify(
          displayName,
        )}${duplicateNote}`,
      );
    } catch (error) {
      if (isMissingFileError(error)) {
        missing++;
        console.log(
          `SKIP missing file=${basename(target.filePath)} rows=${target.rows
            .map((row) => row.id)
            .join(',')}`,
        );
        continue;
      }
      failed++;
      console.error(
        `FAILED file=${basename(target.filePath)}: ${(error as Error).message}`,
      );
    }
  }

  console.log(
    `[publication-pdf-metadata] done updated=${updated} skipped=${skipped} missing=${missing} failed=${failed}`,
  );
  if (failed > 0) process.exitCode = 1;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function groupPublicationFiles(rows: PublicationRow[]): PublicationFile[] {
  const groups = new Map<string, PublicationRow[]>();

  for (const row of rows) {
    const filePath = resolvePublicationPath(row.url);
    if (!filePath) continue;
    const existing = groups.get(filePath) ?? [];
    existing.push(row);
    groups.set(filePath, existing);
  }

  return [...groups.entries()].map(([filePath, groupedRows]) => ({
    filePath,
    rows: groupedRows,
  }));
}

function resolvePublicationPath(url: string): string | null {
  try {
    const pathname = decodeURIComponent(
      new URL(url, 'http://localhost').pathname,
    );
    const prefix = '/uploads/products/cong-bo/';
    if (!pathname.startsWith(prefix) || !pathname.endsWith('.pdf')) {
      return null;
    }

    const filePath = resolve(uploadsRoot, pathname.slice('/uploads/'.length));
    if (
      !filePath.startsWith(`${publicationRoot}${sep}`) ||
      relative(publicationRoot, filePath).includes(`..${sep}`)
    ) {
      return null;
    }
    return filePath;
  } catch {
    return null;
  }
}

async function readPdfTitle(input: Uint8Array): Promise<string | null> {
  const pdf = await PDFDocument.load(input, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
  return pdf.getTitle() ?? null;
}

function parseArgs(args: string[]): Options & { help?: boolean } {
  const options: Options & { help?: boolean } = { apply: false };
  for (const arg of args) {
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--limit=')) {
      const limit = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error('--limit phải là số nguyên dương');
      }
      options.limit = limit;
    } else {
      throw new Error(`Tham số không được hỗ trợ: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`
Backfill metadata tên file PDF công bố.

  yarn backfill:publication-pdf-metadata
  yarn backfill:publication-pdf-metadata --limit=100
  yarn backfill:publication-pdf-metadata --apply

Mặc định chỉ preview. Chỉ --apply mới ghi metadata vào PDF.
URL và tên file vật lý không thay đổi.
`);
}

main()
  .catch((error) => {
    console.error('[publication-pdf-metadata] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
