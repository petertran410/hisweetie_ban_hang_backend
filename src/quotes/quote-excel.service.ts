import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { marginPct } from './quote-pricing';
import type { QuotesService } from './quotes.service';

type Quote = ReturnType<QuotesService['toQuote']>;

// Nạp sharp lúc cần (như upload.service): binary lỗi thì chỉ mất ảnh, app không sập.
type SharpFn = typeof import('sharp');
let sharpFn: SharpFn | null | undefined;
function getSharp(): SharpFn | null {
  if (sharpFn !== undefined) return sharpFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sharpFn = require('sharp') as SharpFn;
  } catch {
    sharpFn = null;
  }
  return sharpFn;
}

const FONT = 'Times New Roman';
const THIN = { style: 'thin' as const, color: { argb: 'FF000000' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/**
 * Xuất báo giá ra .xlsx theo bố cục sheet "BẢNG BÁO GIÁ TỔNG HỢP":
 * đầu trang công ty / quốc hiệu, tiêu đề, ngày áp dụng, kính gửi, lời mở đầu,
 * bảng STT · Tên · Quy cách · Hình ảnh · cột giá (· Lợi nhuận), lời kết.
 */
@Injectable()
export class QuoteExcelService {
  private readonly logger = new Logger(QuoteExcelService.name);

  async build(q: Quote): Promise<Buffer> {
    // Dòng không áp khung số lượng: in một cột "Giá bán" (giá bán sửa trên form).
    const items = q.items.map((it) =>
      it.tiers.length
        ? it
        : {
            ...it,
            tiers: [
              {
                key: 'gia_ban',
                label: 'Giá bán',
                minQty: null,
                maxQty: null,
                unit: '',
                price: it.basePrice,
                manual: true,
              },
            ],
          },
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(q.code, {
      pageSetup: {
        paperSize: 9,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });

    const cols: { key: string; label: string }[] = [];
    for (const it of items)
      for (const t of it.tiers)
        if (!cols.some((c) => c.key === t.key))
          cols.push({ key: t.key, label: t.label });
    const showMargin = q.showMargin && cols.length > 1;
    // A lề · B STT · C Tên · D Quy cách · E Hình ảnh · F.. giá · (Lợi nhuận)
    const firstPrice = 6;
    const last = firstPrice + cols.length - 1 + (showMargin ? 1 : 0);
    ws.columns = [
      { width: 2 },
      { width: 6 },
      { width: 38 },
      { width: 16 },
      { width: 16 },
      ...cols.map(() => ({ width: 17 })),
      ...(showMargin ? [{ width: 12 }] : []),
    ];

    const put = (
      row: number,
      c1: number,
      c2: number,
      value: string,
      font: Partial<ExcelJS.Font> = {},
      align: Partial<ExcelJS.Alignment> = {
        horizontal: 'center',
        vertical: 'middle',
      },
    ) => {
      if (c2 > c1) ws.mergeCells(row, c1, row, c2);
      const cell = ws.getCell(row, c1);
      cell.value = value;
      cell.font = { name: FONT, size: 13, ...font };
      cell.alignment = { wrapText: true, ...align };
      return cell;
    };

    // Đầu trang: công ty (trái) · quốc hiệu (phải)
    const mid = Math.max(5, firstPrice - 1);
    const right1 = Math.min(mid + 1, last);
    const [y, m, d] = q.appliedFrom.split('-');
    // Tên công ty theo mẫu: dòng 1 · các dòng còn lại gộp vào dòng 2
    const [co1 = '', ...coRest] = q.companyName.split('\n');
    put(1, 2, mid, co1, { bold: true });
    put(2, 2, mid, coRest.join(' '), { bold: true });
    if (q.department) {
      put(3, 2, mid, '*', { bold: true });
      put(4, 2, mid, q.department, { bold: true });
    }
    if (right1 <= last) {
      put(1, right1, last, 'CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM', {
        bold: true,
      });
      put(2, right1, last, 'Độc Lập - Tự Do - Hạnh Phúc', { bold: true });
      put(4, right1, last, `Hà Nội, Ngày ${d} tháng ${m} năm ${y}`, {
        italic: true,
      });
    }

    const dmy = (iso: string) => iso.split('-').reverse().join('/');
    put(5, 2, last, q.title, { bold: true, size: 16 });
    put(
      6,
      2,
      last,
      `(Áp dụng cho khách hàng từ ngày ${dmy(q.appliedFrom)}${q.validUntil ? ` đến ngày ${dmy(q.validUntil)}` : ''})`,
      { italic: true },
    );
    const c = q.customer;
    const contact = [
      c?.contactNumber && `ĐT: ${c.contactNumber}`,
      c?.address && `Địa chỉ: ${c.address}`,
    ]
      .filter(Boolean)
      .join(' · ');
    put(
      7,
      2,
      last,
      `Kính gửi: ${q.greeting}${c ? ` ${c.name}` : ''}${contact ? ` (${contact})` : ''}`,
      { bold: true, italic: true },
      { horizontal: 'left', vertical: 'middle' },
    );
    put(
      8,
      2,
      last,
      q.intro,
      { italic: true },
      { horizontal: 'left', vertical: 'top' },
    );
    ws.getRow(8).height = 48;

    // Bảng giá
    const header = [
      'STT',
      'Tên sản phẩm',
      'Quy cách',
      'Hình ảnh',
      ...cols.map((x) => `${x.label}\n(Đã bao gồm VAT)`),
      ...(showMargin ? ['Lợi nhuận'] : []),
    ];
    header.forEach((h, i) => {
      const cell = ws.getCell(9, i + 2);
      cell.value = h;
      cell.font = { name: FONT, size: 13, bold: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFFF00' },
      };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      cell.border = BORDER;
    });
    ws.getRow(9).height = 44;

    const images = await Promise.all(
      items.map((it) => this.image(it.imageUrl)),
    );
    items.forEach((it, i) => {
      const r = 10 + i;
      const values: (string | number | null)[] = [
        i + 1,
        // Tên hiển thị + khối lượng, vd "Gấu Lermao - Mứt Xoài Xanh 1kg"
        [it.productName, it.weight].filter(Boolean).join(' '),
        it.spec ? `(${it.spec})` : '',
        '',
        ...cols.map((x) =>
          it.comingSoon
            ? 'COMING SOON'
            : (it.tiers.find((t) => t.key === x.key)?.price ?? null),
        ),
        ...(showMargin ? [it.comingSoon ? '' : marginPct(it.tiers)] : []),
      ];
      values.forEach((v, k) => {
        const cell = ws.getCell(r, k + 2);
        cell.value = v as ExcelJS.CellValue;
        cell.font = { name: FONT, size: 13 };
        cell.border = BORDER;
        cell.alignment = {
          horizontal: k === 1 ? 'left' : 'center',
          vertical: 'middle',
          wrapText: true,
        };
        if (k >= 4 && typeof v === 'number')
          cell.numFmt = showMargin && k === values.length - 1 ? '0%' : '#,##0';
      });
      ws.getRow(r).height = 72;
      const img = images[i];
      if (img) {
        const id = wb.addImage({
          buffer: img as unknown as ExcelJS.Buffer,
          extension: 'png',
        });
        // Cột E (index 4, 0-based), canh giữa ô
        ws.addImage(id, {
          tl: { col: 4.2, row: r - 1 + 0.08 },
          ext: { width: 88, height: 88 },
          editAs: 'oneCell',
        });
      }
    });

    let r = 10 + items.length;
    put(
      r,
      2,
      last,
      'Đơn vị tính giá: VNĐ / đơn vị bán (túi, hộp, gói…).',
      { italic: true, size: 11 },
      { horizontal: 'left' },
    );
    r++;
    if (q.note.trim()) {
      put(
        r,
        2,
        last,
        `Chính sách / ghi chú: ${q.note}`,
        {},
        { horizontal: 'left', vertical: 'top' },
      );
      ws.getRow(r).height = Math.min(120, 20 * (q.note.split('\n').length + 1));
      r++;
    }
    put(r, 2, last, q.closing, {}, { horizontal: 'left', vertical: 'top' });
    ws.getRow(r).height = 48;

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Ảnh sản phẩm → PNG nhỏ (Excel không nhận webp). Lỗi → bỏ ảnh, vẫn xuất file. */
  private async image(url: string | null): Promise<Buffer | null> {
    const sharp = getSharp();
    if (!url || !sharp) return null;
    try {
      let input: Buffer;
      const local = url.startsWith('/') ? join(process.cwd(), url) : null;
      if (local && existsSync(local)) input = await readFile(local);
      else {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        input = Buffer.from(await res.arrayBuffer());
      }
      return await sharp(input)
        .resize(176, 176, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer();
    } catch (e) {
      this.logger.warn(`Bỏ ảnh báo giá ${url}: ${(e as Error).message}`);
      return null;
    }
  }
}
