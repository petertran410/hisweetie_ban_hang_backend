import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, rgb } from 'pdf-lib';
import * as fontkitModule from '@pdf-lib/fontkit';
import * as fs from 'fs';
import * as path from 'path';

// @pdf-lib/fontkit export khác nhau giữa CJS/ESM — lấy đúng instance.
const fontkit: any =
  (fontkitModule as any).default || (fontkitModule as any);

/**
 * Một ô text cần "nung" thẳng vào PDF (chữ in cứng, KHÔNG viền — khác field
 * Documenso). Toạ độ theo % (giống Documenso field: gốc trên-trái, X/Y/W/H là
 * phần trăm so với kích thước trang).
 */
export interface BurnTextItem {
  page: number; // 1-based
  /** % từ trái */
  xPercent: number;
  /** % từ trên xuống */
  yPercent: number;
  /** % chiều rộng ô */
  widthPercent: number;
  /** % chiều cao ô */
  heightPercent: number;
  value: string;
  /** Cỡ chữ (point). Mặc định auto theo chiều cao ô. */
  fontSize?: number;
  align?: 'left' | 'center' | 'right';
}

/**
 * Một ảnh (PNG) cần "nung" vào PDF — dùng cho chữ ký + con dấu công ty. Toạ độ
 * theo % giống BurnTextItem. Ảnh được fit GỌN trong ô (giữ tỉ lệ, căn giữa).
 */
export interface BurnImageItem {
  page: number; // 1-based
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  /** PNG buffer (nền trong suốt). */
  imageBuffer: Buffer;
}

@Injectable()
export class PdfBurnService {
  private readonly logger = new Logger(PdfBurnService.name);
  private fontRegularBytes: Uint8Array | null = null;
  private fontBoldBytes: Uint8Array | null = null;

  private loadFonts() {
    if (this.fontRegularBytes && this.fontBoldBytes) return;
    // Tìm font ở nhiều vị trí — khác nhau giữa dev (dist/src/contracts) và
    // các kiểu build/output khác. Ưu tiên cạnh file biên dịch (__dirname),
    // fallback về source và dist gốc.
    const candidates = [
      path.join(__dirname, 'assets', 'fonts'),
      path.join(process.cwd(), 'src', 'contracts', 'assets', 'fonts'),
      path.join(process.cwd(), 'dist', 'src', 'contracts', 'assets', 'fonts'),
      path.join(process.cwd(), 'dist', 'contracts', 'assets', 'fonts'),
    ];
    const fontDir = candidates.find((d) =>
      fs.existsSync(path.join(d, 'times.ttf')),
    );
    if (!fontDir) {
      throw new Error(
        `Không tìm thấy font times.ttf. Đã thử: ${candidates.join(', ')}`,
      );
    }
    const regular = path.join(fontDir, 'times.ttf');
    const bold = path.join(fontDir, 'times-bold.ttf');
    this.fontRegularBytes = fs.readFileSync(regular);
    this.fontBoldBytes = fs.existsSync(bold)
      ? fs.readFileSync(bold)
      : this.fontRegularBytes;
  }

  /**
   * Vẽ các ô text lên PDF, trả về buffer PDF mới. Text căn giữa theo chiều dọc
   * của ô (giống verticalAlign middle của Documenso) và canh theo align ngang.
   */
  async burnText(pdfBuffer: Buffer, items: BurnTextItem[]): Promise<Buffer> {
    if (!items.length) return pdfBuffer;
    this.loadFonts();

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);
    const font = await pdfDoc.embedFont(this.fontRegularBytes!, {
      subset: true,
    });

    const pages = pdfDoc.getPages();

    for (const item of items) {
      const pageIndex = (item.page || 1) - 1;
      if (pageIndex < 0 || pageIndex >= pages.length) {
        this.logger.warn(`burnText: page ${item.page} ngoài phạm vi — bỏ qua`);
        continue;
      }
      const page = pages[pageIndex];
      const { width: pw, height: ph } = page.getSize();

      const boxX = (item.xPercent / 100) * pw;
      const boxYTop = (item.yPercent / 100) * ph; // tính từ trên xuống
      const boxW = (item.widthPercent / 100) * pw;
      const boxH = (item.heightPercent / 100) * ph;

      const value = String(item.value ?? '');
      if (!value) continue;

      // Cỡ chữ: ưu tiên fontSize cho trước, nếu không thì ~70% chiều cao ô,
      // rồi co lại nếu quá rộng so với ô.
      let fontSize = item.fontSize && item.fontSize > 0 ? item.fontSize : boxH * 0.7;
      fontSize = Math.max(6, Math.min(fontSize, 48));
      let textWidth = font.widthOfTextAtSize(value, fontSize);
      while (textWidth > boxW && fontSize > 6) {
        fontSize -= 0.5;
        textWidth = font.widthOfTextAtSize(value, fontSize);
      }

      // Canh ngang trong ô.
      let drawX = boxX;
      const align = item.align || 'left';
      if (align === 'center') drawX = boxX + (boxW - textWidth) / 2;
      else if (align === 'right') drawX = boxX + (boxW - textWidth);

      // Canh giữa theo chiều dọc. pdf-lib vẽ theo baseline, gốc toạ độ ở góc
      // DƯỚI-trái. Documenso đặt ô theo góc TRÊN-trái (%). Với verticalAlign
      // middle: tâm thị giác của chữ (≈ nửa cap-height) trùng tâm ô. Times có
      // cap-height ≈ 0.7×fontSize → baseline nằm dưới tâm ô ≈ 0.35×fontSize.
      const boxCenterFromTop = boxYTop + boxH / 2;
      const baselineFromTop = boxCenterFromTop + fontSize * 0.35;
      const drawY = ph - baselineFromTop;

      page.drawText(value, {
        x: drawX,
        y: drawY,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    }

    const out = await pdfDoc.save();
    return Buffer.from(out);
  }

  /**
   * Vẽ text + ảnh (chữ ký/con dấu công ty) lên PDF trong 1 lần load. Trả buffer
   * PDF mới. Dùng cho Phase 2: PDF có sẵn text + dấu công ty TRƯỚC khi đẩy sang
   * Documenso (phải nung trước khi cert.p12 niêm phong, nếu không sẽ phá chữ ký số).
   */
  async burnTextAndImages(
    pdfBuffer: Buffer,
    textItems: BurnTextItem[],
    imageItems: BurnImageItem[],
  ): Promise<Buffer> {
    if (!textItems.length && !imageItems.length) return pdfBuffer;
    this.loadFonts();

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);
    const font = await pdfDoc.embedFont(this.fontRegularBytes!, {
      subset: true,
    });
    const pages = pdfDoc.getPages();

    // --- Text ---
    for (const item of textItems) {
      this.drawTextItem(pages, font, item);
    }

    // --- Images (chữ ký + dấu) ---
    for (const item of imageItems) {
      const pageIndex = (item.page || 1) - 1;
      if (pageIndex < 0 || pageIndex >= pages.length) {
        this.logger.warn(`burnImage: page ${item.page} ngoài phạm vi — bỏ qua`);
        continue;
      }
      if (!item.imageBuffer?.length) continue;
      const page = pages[pageIndex];
      const { width: pw, height: ph } = page.getSize();

      let png;
      try {
        png = await pdfDoc.embedPng(item.imageBuffer);
      } catch (e) {
        this.logger.warn(`burnImage: nhúng PNG lỗi — bỏ qua: ${e}`);
        continue;
      }

      const boxX = (item.xPercent / 100) * pw;
      const boxYTop = (item.yPercent / 100) * ph;
      const boxW = (item.widthPercent / 100) * pw;
      const boxH = (item.heightPercent / 100) * ph;

      // Fit giữ tỉ lệ trong ô, căn giữa.
      const scale = Math.min(boxW / png.width, boxH / png.height);
      const drawW = png.width * scale;
      const drawH = png.height * scale;
      const drawX = boxX + (boxW - drawW) / 2;
      // pdf-lib gốc dưới-trái; ô đo từ trên xuống.
      const drawYTop = boxYTop + (boxH - drawH) / 2;
      const drawY = ph - drawYTop - drawH;

      page.drawImage(png, { x: drawX, y: drawY, width: drawW, height: drawH });
    }

    const out = await pdfDoc.save();
    return Buffer.from(out);
  }

  /** Vẽ 1 ô text vào trang (tách riêng để dùng chung). */
  private drawTextItem(
    pages: any[],
    font: any,
    item: BurnTextItem,
  ): void {
    const pageIndex = (item.page || 1) - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) {
      this.logger.warn(`burnText: page ${item.page} ngoài phạm vi — bỏ qua`);
      return;
    }
    const page = pages[pageIndex];
    const { width: pw, height: ph } = page.getSize();

    const boxX = (item.xPercent / 100) * pw;
    const boxYTop = (item.yPercent / 100) * ph;
    const boxW = (item.widthPercent / 100) * pw;
    const boxH = (item.heightPercent / 100) * ph;

    const value = String(item.value ?? '');
    if (!value) return;

    let fontSize =
      item.fontSize && item.fontSize > 0 ? item.fontSize : boxH * 0.7;
    fontSize = Math.max(6, Math.min(fontSize, 48));
    let textWidth = font.widthOfTextAtSize(value, fontSize);
    while (textWidth > boxW && fontSize > 6) {
      fontSize -= 0.5;
      textWidth = font.widthOfTextAtSize(value, fontSize);
    }

    let drawX = boxX;
    const align = item.align || 'left';
    if (align === 'center') drawX = boxX + (boxW - textWidth) / 2;
    else if (align === 'right') drawX = boxX + (boxW - textWidth);

    const boxCenterFromTop = boxYTop + boxH / 2;
    const baselineFromTop = boxCenterFromTop + fontSize * 0.35;
    const drawY = ph - baselineFromTop;

    page.drawText(value, {
      x: drawX,
      y: drawY,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
  }
}
