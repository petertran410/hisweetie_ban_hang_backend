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
    this.fromAddress = this.configService.get<string>('LARK_SMTP_USER') || '';
    this.fromName =
      this.configService.get<string>('LARK_SMTP_FROM_NAME') || 'Diệp Trà';
  }

  private getTransporter(): nodemailer.Transporter {
    if (this.transporter) return this.transporter;

    const host =
      this.configService.get<string>('LARK_SMTP_HOST') || 'smtp.larksuite.com';
    const port =
      Number(this.configService.get<string>('LARK_SMTP_PORT')) || 465;
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
  buildReviewHtml(params: { customerName: string; reviewUrl: string }): string {
    const approveUrl = `${params.reviewUrl}?action=approve`;
    const rejectUrl = `${params.reviewUrl}?action=reject`;
    return `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
        <p>Kính gửi Quý khách <strong>${escapeHtml(params.customerName)}</strong>,</p>
        <p>Công ty Diệp Trà trân trọng gửi tới Quý khách <strong>bản dự thảo hợp đồng</strong>
        để xem trước và rà soát nội dung (xem file đính kèm).</p>
        <p>Đây là <strong>bản nháp chưa có giá trị ký kết</strong>. Quý khách vui lòng
        kiểm tra kỹ các thông tin: tên đơn vị, mã số thuế, địa chỉ, tài khoản và
        các điều khoản trong hợp đồng.</p>
        <p>Sau khi rà soát, vui lòng chọn một trong hai phương án dưới đây:</p>
        <table cellpadding="0" cellspacing="0" style="margin:20px 0">
          <tr>
            <td style="padding-right:12px">
              <a href="${approveUrl}"
                 style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;
                        padding:12px 28px;border-radius:6px;font-weight:bold;font-size:15px">
                ✓ Đồng ý &amp; tiến hành ký
              </a>
            </td>
            <td>
              <a href="${rejectUrl}"
                 style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;
                        padding:12px 28px;border-radius:6px;font-weight:bold;font-size:15px">
                ✗ Không đồng ý
              </a>
            </td>
          </tr>
        </table>
        <p style="font-size:13px;color:#666">
          Khi nhấn <strong>"Đồng ý &amp; tiến hành ký"</strong>, chúng tôi sẽ gửi ngay
          bản hợp đồng điện tử chính thức để Quý khách ký. Nếu cần điều chỉnh, vui lòng
          nhấn <strong>"Không đồng ý"</strong> hoặc phản hồi email này kèm nội dung cần sửa.
        </p>
        <p>Trân trọng cảm ơn,<br/><strong>Công ty TNHH Xuất Nhập Khẩu Hi Sweetie Việt Nam</strong></p>
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
        <p>Kính gửi Quý khách <strong>${escapeHtml(params.customerName)}</strong>,</p>
        <p>Hợp đồng <strong>${escapeHtml(params.contractTitle)}</strong> đã được hai bên ký kết hoàn tất.
        Chúng tôi xin gửi lại Quý khách file hợp đồng có đầy đủ chữ ký điện tử
        của hai bên (file đính kèm).</p>
        <p>Hợp đồng này có giá trị pháp lý kể từ ngày ký. Quý khách vui lòng lưu giữ
        file này để làm căn cứ thực hiện hợp đồng.</p>
        <p>Trân trọng cảm ơn Quý khách đã tin tưởng hợp tác cùng
        <strong>Công ty TNHH Xuất Nhập Khẩu Hi Sweetie Việt Nam</strong>.</p>
        <p>Trân trọng,<br/><strong>Công ty TNHH Xuất Nhập Khẩu Hi Sweetie Việt Nam</strong></p>
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
