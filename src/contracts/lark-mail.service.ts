import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Gửi email hợp đồng qua Lark Mail (SMTP).
 *  - Bản review (Phase 1): PDF đã nung text công ty, KHÔNG có ô ký — để khách xem.
 *  - Bản hoàn tất (Phase 4): PDF 2 bên đã ký + niêm phong số — gửi lại cho khách.
 *
 * ENV:
 *  LARK_SMTP_HOST=smtp.larksuite.com
 *  LARK_SMTP_PORT=465
 *  LARK_SMTP_SECURE=true
 *  LARK_SMTP_USER=contract@hisweetievietnam.com.vn
 *  LARK_SMTP_PASS=...
 *  LARK_SMTP_FROM_NAME=Diệp Trà   (tùy chọn)
 */
@Injectable()
export class LarkMailService {
  private readonly logger = new Logger(LarkMailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly fromName: string;
  private readonly fromAddress: string;

  constructor(private readonly configService: ConfigService) {
    this.fromAddress =
      this.configService.get<string>('LARK_SMTP_USER') || '';
    this.fromName =
      this.configService.get<string>('LARK_SMTP_FROM_NAME') || 'Diệp Trà';
  }

  private getTransporter(): nodemailer.Transporter {
    if (this.transporter) return this.transporter;

    const host =
      this.configService.get<string>('LARK_SMTP_HOST') || 'smtp.larksuite.com';
    const port = Number(this.configService.get<string>('LARK_SMTP_PORT')) || 465;
    const secureRaw = this.configService.get<string>('LARK_SMTP_SECURE');
    const secure = secureRaw ? secureRaw === 'true' : port === 465;
    const user = this.configService.get<string>('LARK_SMTP_USER') || '';
    const pass = this.configService.get<string>('LARK_SMTP_PASS') || '';

    if (!user || !pass) {
      throw new Error(
        'Lark Mail chưa cấu hình (thiếu LARK_SMTP_USER / LARK_SMTP_PASS)',
      );
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure, // 465 = SSL; 587 = STARTTLS (secure=false)
      auth: { user, pass },
    });
    return this.transporter;
  }

  /**
   * Gửi mail kèm 1 file PDF đính kèm.
   */
  async sendMailWithPdf(params: {
    to: string;
    subject: string;
    html: string;
    pdfBuffer: Buffer;
    pdfFileName: string;
    cc?: string[];
  }): Promise<void> {
    const transporter = this.getTransporter();
    await transporter.sendMail({
      from: `"${this.fromName}" <${this.fromAddress}>`,
      to: params.to,
      cc: params.cc?.length ? params.cc : undefined,
      subject: params.subject,
      html: params.html,
      attachments: [
        {
          filename: params.pdfFileName,
          content: params.pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
    this.logger.log(`Đã gửi Lark Mail tới ${params.to}: ${params.subject}`);
  }

  /** Email bản xem trước (Phase 1) — khách xem nội dung, chưa ký. */
  buildReviewHtml(params: {
    customerName: string;
    contractTitle: string;
  }): string {
    return `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
        <p>Kính gửi <strong>${escapeHtml(params.customerName)}</strong>,</p>
        <p>Diệp Trà xin gửi tới Quý khách bản xem trước hợp đồng
        <strong>${escapeHtml(params.contractTitle)}</strong> (đính kèm).</p>
        <p>Quý khách vui lòng kiểm tra nội dung. Nếu đồng ý, vui lòng phản hồi lại
        email này để chúng tôi gửi bản ký điện tử chính thức.</p>
        <p>Trân trọng,<br/>Diệp Trà</p>
      </div>
    `;
  }

  /** Email bản hoàn tất (Phase 4) — 2 bên đã ký. */
  buildCompletedHtml(params: {
    customerName: string;
    contractTitle: string;
  }): string {
    return `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
        <p>Kính gửi <strong>${escapeHtml(params.customerName)}</strong>,</p>
        <p>Hợp đồng <strong>${escapeHtml(params.contractTitle)}</strong> đã được
        hai bên ký kết hoàn tất. File hợp đồng có đầy đủ chữ ký điện tử được đính
        kèm trong email này.</p>
        <p>Cảm ơn Quý khách đã hợp tác cùng Diệp Trà.</p>
        <p>Trân trọng,<br/>Diệp Trà</p>
      </div>
    `;
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
