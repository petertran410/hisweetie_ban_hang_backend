import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Gửi email hợp đồng qua Lark Mail (SMTP).
 *
 * Luồng mới (sau khi gộp review):
 *  - Mail #1 (gửi cho khách): thông tin HĐ + link Documenso ký trực tiếp.
 *  - Mail nhận kết quả ký của khách (gửi về NV mailbox nội bộ).
 *  - Mail hoàn tất (gửi cả khách + NV): PDF 2 bên đã ký.
 *
 * Tất cả mail nhận từ NV về `contract@hisweetievietnam.com.vn` (CC mặc định).
 *
 * ENV:
 *  LARK_SMTP_HOST=smtp.larksuite.com
 *  LARK_SMTP_PORT=465
 *  LARK_SMTP_USER=contract@hisweetievietnam.com.vn
 *  LARK_SMTP_PASS=...
 *  LARK_SMTP_FROM_NAME=Diệp Trà
 *  CONTRACT_INTERNAL_MAIL=contract@hisweetievietnam.com.vn   (mặc định user SMTP)
 */
@Injectable()
export class LarkMailService {
  private readonly logger = new Logger(LarkMailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly fromName: string;
  private readonly fromAddress: string;
  private readonly internalMail: string;

  constructor(private readonly configService: ConfigService) {
    this.fromAddress = this.configService.get<string>('LARK_SMTP_USER') || '';
    this.fromName =
      this.configService.get<string>('LARK_SMTP_FROM_NAME') || 'Diệp Trà';
    this.internalMail =
      this.configService.get<string>('CONTRACT_INTERNAL_MAIL') ||
      this.fromAddress;
  }

  /** Mail nội bộ NV (mặc định: cùng mail Lark user). */
  getInternalMail(): string {
    return this.internalMail;
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
   * Gửi mail kèm 1 file PDF đính kèm (tuỳ chọn).
   */
  async sendMailWithPdf(params: {
    to: string;
    subject: string;
    html: string;
    pdfBuffer?: Buffer;
    pdfFileName?: string;
    cc?: string[];
  }): Promise<void> {
    const transporter = this.getTransporter();
    const attachments =
      params.pdfBuffer && params.pdfFileName
        ? [
            {
              filename: params.pdfFileName,
              content: params.pdfBuffer,
              contentType: 'application/pdf',
            },
          ]
        : undefined;

    await transporter.sendMail({
      from: `"${this.fromName}" <${this.fromAddress}>`,
      to: params.to,
      cc: params.cc?.length ? params.cc : undefined,
      subject: params.subject,
      html: params.html,
      attachments,
    });
    this.logger.log(`Đã gửi Lark Mail tới ${params.to}: ${params.subject}`);
  }

  /**
   * Mail #1 cho khách: thông tin HĐ đã fill ở POS + nút/link mở Documenso ký.
   * Không kèm file — link Documenso đã có PDF preview bên trong.
   */
  buildSentToCustomerHtml(params: {
    customerName: string;
    contractTitle: string;
    signingUrl: string;
    summary?: string;
  }): string {
    const safeUrl = escapeAttr(params.signingUrl);
    return `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
        <p>Kính gửi Quý khách <strong>${escapeHtml(params.customerName)}</strong>,</p>
        <p>Công ty Diệp Trà trân trọng gửi tới Quý khách hợp đồng
          <strong>${escapeHtml(params.contractTitle)}</strong>.</p>
        ${params.summary ? `<p>${escapeHtml(params.summary)}</p>` : ''}
        <p>Vui lòng nhấn vào nút bên dưới để xem nội dung và ký điện tử. Hợp đồng
        có hiệu lực pháp lý ngay khi Quý khách hoàn tất ký kết.</p>
        <p style="margin:24px 0">
          <a href="${safeUrl}"
             style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;
                    padding:14px 36px;border-radius:6px;font-weight:bold;font-size:16px">
            ✍ Mở hợp đồng &amp; ký điện tử
          </a>
        </p>
        <p style="font-size:13px;color:#666">
          Liên kết ký có giá trị và an toàn. Nếu Quý khách gặp khó khăn, vui lòng
          phản hồi email này để nhân viên Diệp Trà hỗ trợ.
        </p>
        <p>Trân trọng,<br/><strong>Công ty TNHH Xuất Nhập Khẩu Hi Sweetie Việt Nam</strong></p>
      </div>
    `;
  }

  /**
   * Mail #1 — kết quả ký khách (tuần tự). Gửi về NV mailbox nội bộ kèm PDF
   * có chữ ký khách để NV xem và ký tiếp (Loại 2), hoặc PDF hoàn tất (Loại 1).
   */
  buildCustomerSignedToStaffHtml(params: {
    customerName: string;
    contractTitle: string;
    isTwoParty: boolean;
    staffSigningUrl?: string;
  }): string {
    const nextStep = params.isTwoParty
      ? `<p>Vui lòng <strong>mở liên kết bên dưới để ký phần BÊN A</strong> (có hiệu lực
      ngay khi bạn hoàn tất, vì hợp đồng đã có chữ ký BÊN B).</p>
        <p style="margin:20px 0">
          <a href="${escapeAttr(params.staffSigningUrl || '#')}"
             style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;
                    padding:14px 36px;border-radius:6px;font-weight:bold;font-size:16px">
            ✍ Mở hợp đồng &amp; ký phần công ty
          </a>
        </p>`
      : `<p><strong>Hợp đồng đã hoàn tất ký kết.</strong> File PDF đính kèm đã có đầy đủ
      chữ ký hai bên. Bạn có thể tải về tại trang POS.</p>`;

    return `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
        <p>Thông báo nội bộ Diệp Trà,</p>
        <p>Khách hàng <strong>${escapeHtml(params.customerName)}</strong> vừa hoàn tất
          ký điện tử hợp đồng <strong>${escapeHtml(params.contractTitle)}</strong>.</p>
        ${nextStep}
        <p style="font-size:13px;color:#666">
          File PDF đính kèm có chữ ký của khách để bạn đối chiếu.
        </p>
      </div>
    `;
  }

  /**
   * Mail #2 — HĐ hoàn tất 2 bên đã ký. Gửi cho cả khách và NV.
   * Kèm PDF có cả 2 chữ ký.
   */
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

  /** Subject cho mail #1 gửi khách. */
  subjectSentToCustomer(contractTitle: string): string {
    return `[Diệp Trà] Hợp đồng ${contractTitle} — kính mời ký điện tử`;
  }

  /** Subject cho mail "NV — khách đã ký". */
  subjectCustomerSigned(customerName: string, contractTitle: string): string {
    return `[Diệp Trà] ${customerName} đã ký xong — ${contractTitle}`;
  }

  /** Subject cho mail hoàn tất. */
  subjectCompleted(contractTitle: string): string {
    return `[Diệp Trà] Hợp đồng ${contractTitle} đã hoàn tất ký kết`;
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
