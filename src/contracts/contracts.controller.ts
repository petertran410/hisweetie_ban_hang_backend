import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  Req,
  Res,
  UseInterceptors,
  UploadedFile,
  UnauthorizedException,
  InternalServerErrorException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import * as crypto from 'crypto';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ContractsService } from './contracts.service';
import {
  CreateFromTemplateDto,
  UploadContractDto,
  ContractQueryDto,
  DocumensoWebhookDto,
} from './dto';

@ApiTags('Contracts')
@ApiBearerAuth()
@Controller('contracts')
export class ContractsController {
  private readonly logger = new Logger(ContractsController.name);

  constructor(
    private readonly contractsService: ContractsService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @RequirePermissions('contracts:view')
  @ApiOperation({ summary: 'Danh sách hợp đồng' })
  async findAll(@Query() query: ContractQueryDto) {
    return this.contractsService.findAll(query);
  }

  @Get('templates')
  @RequirePermissions('contracts:create')
  @ApiOperation({ summary: 'Danh sách loại hợp đồng (template Documenso)' })
  async listTemplates() {
    return this.contractsService.listTemplates();
  }

  @Get('templates/:id/fields')
  @RequirePermissions('contracts:create')
  @ApiOperation({
    summary: 'Field công ty cần điền của template (FE render form động)',
  })
  async getTemplateFields(@Param('id') id: string) {
    return this.contractsService.getTemplateFields(Number(id));
  }

  @Get(':id')
  @RequirePermissions('contracts:view')
  @ApiOperation({ summary: 'Chi tiết hợp đồng' })
  async findOne(@Param('id') id: string) {
    return this.contractsService.findOne(Number(id));
  }

  @Post('from-template')
  @RequirePermissions('contracts:create')
  @ApiOperation({ summary: 'Tạo & gửi bản XEM TRƯỚC hợp đồng (Lark Mail)' })
  async createFromTemplate(
    @Body() dto: CreateFromTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.contractsService.createFromTemplate(dto, user?.id);
  }

  @Post(':id/approve-review')
  @RequirePermissions('contracts:send')
  @ApiOperation({
    summary: 'Đánh dấu khách đã đồng ý nội dung (bản xem trước)',
  })
  async approveReview(@Param('id') id: string) {
    return this.contractsService.approveReview(Number(id));
  }

  @Post(':id/send-for-signing')
  @RequirePermissions('contracts:send')
  @ApiOperation({ summary: 'Gửi bản KÝ điện tử cho khách (Documenso)' })
  async sendForSigning(@Param('id') id: string) {
    return this.contractsService.sendForSigning(Number(id));
  }

  /**
   * Trang public khách bấm từ email: hiển thị nút xác nhận (không tự chạy để
   * tránh email scanner prefetch). action=approve | reject.
   */
  @Public()
  @Get('review/:token')
  @ApiOperation({ summary: 'Trang xác nhận bản dự thảo (khách bấm từ email)' })
  async reviewLanding(
    @Param('token') token: string,
    @Query('action') action: string,
    @Res() res: Response,
  ) {
    let contract: any;
    try {
      contract = await this.contractsService.findByReviewToken(token);
    } catch {
      return res
        .status(404)
        .type('html')
        .send(
          this.htmlPage(
            'Liên kết không hợp lệ',
            'Liên kết xác nhận không tồn tại hoặc đã hết hạn.',
            'error',
          ),
        );
    }

    // Đã xử lý xong trước đó → hiện trạng thái.
    if (['SENT', 'SIGNED'].includes(contract.status)) {
      return res
        .type('html')
        .send(
          this.htmlPage(
            'Đã xác nhận',
            'Quý khách đã đồng ý bản dự thảo. Bản hợp đồng điện tử để ký đã được gửi tới email của Quý khách. Vui lòng kiểm tra hộp thư.',
            'success',
          ),
        );
    }
    if (contract.status === 'REJECTED') {
      return res
        .type('html')
        .send(
          this.htmlPage(
            'Đã ghi nhận',
            'Quý khách đã từ chối bản dự thảo này. Nhân viên Diệp Trà sẽ liên hệ lại để điều chỉnh.',
            'neutral',
          ),
        );
    }

    const isReject = action === 'reject';
    const title = isReject
      ? 'Xác nhận KHÔNG đồng ý'
      : 'Xác nhận đồng ý hợp đồng';
    const desc = isReject
      ? 'Quý khách xác nhận <strong>không đồng ý</strong> với bản dự thảo hợp đồng này? Nhân viên Diệp Trà sẽ liên hệ lại để điều chỉnh.'
      : 'Quý khách xác nhận <strong>đồng ý</strong> với nội dung bản dự thảo? Sau khi xác nhận, chúng tôi sẽ gửi bản hợp đồng điện tử chính thức tới email để Quý khách ký.';
    const btnColor = isReject ? '#dc2626' : '#16a34a';
    const btnText = isReject ? 'Xác nhận không đồng ý' : 'Xác nhận đồng ý';
    const postAction = isReject ? 'reject' : 'approve';

    return res.type('html').send(
      this.htmlConfirmPage({
        title,
        desc,
        btnColor,
        btnText,
        formAction: `/api/contracts/review/${token}/${postAction}`,
      }),
    );
  }

  @Public()
  @Post('review/:token/approve')
  @ApiOperation({ summary: 'Khách đồng ý bản dự thảo → gửi bản ký' })
  async approveByToken(@Param('token') token: string, @Res() res: Response) {
    try {
      await this.contractsService.approveReviewByToken(token);
      return res
        .type('html')
        .send(
          this.htmlPage(
            'Cảm ơn Quý khách!',
            'Quý khách đã đồng ý bản dự thảo. Chúng tôi vừa gửi bản hợp đồng điện tử chính thức tới email của Quý khách. Vui lòng kiểm tra hộp thư để ký.',
            'success',
          ),
        );
    } catch (e: any) {
      return res
        .status(400)
        .type('html')
        .send(
          this.htmlPage(
            'Không thể xử lý',
            e?.message ||
              'Đã có lỗi xảy ra. Vui lòng liên hệ nhân viên Diệp Trà.',
            'error',
          ),
        );
    }
  }

  @Public()
  @Post('review/:token/reject')
  @ApiOperation({ summary: 'Khách không đồng ý bản dự thảo' })
  async rejectByToken(@Param('token') token: string, @Res() res: Response) {
    try {
      await this.contractsService.rejectReviewByToken(token);
      return res
        .type('html')
        .send(
          this.htmlPage(
            'Đã ghi nhận',
            'Cảm ơn Quý khách đã phản hồi. Nhân viên Diệp Trà sẽ liên hệ lại để điều chỉnh nội dung hợp đồng.',
            'neutral',
          ),
        );
    } catch (e: any) {
      return res
        .status(400)
        .type('html')
        .send(
          this.htmlPage(
            'Không thể xử lý',
            e?.message ||
              'Đã có lỗi xảy ra. Vui lòng liên hệ nhân viên Diệp Trà.',
            'error',
          ),
        );
    }
  }

  @Post('upload')
  @RequirePermissions('contracts:create')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Tạo & gửi hợp đồng từ PDF tải lên' })
  async createFromUpload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadContractDto,
    @CurrentUser() user: any,
  ) {
    return this.contractsService.createFromUpload(dto, file, user?.id);
  }

  @Post(':id/resend')
  @RequirePermissions('contracts:send')
  @ApiOperation({ summary: 'Gửi lại hợp đồng' })
  async resend(@Param('id') id: string) {
    return this.contractsService.resend(Number(id));
  }

  @Get(':id/download')
  @RequirePermissions('contracts:download')
  @ApiOperation({ summary: 'Tải PDF đã ký' })
  async download(@Param('id') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.contractsService.getSignedPdf(
      Number(id),
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @Get(':id/preview')
  @RequirePermissions('contracts:view')
  @ApiOperation({ summary: 'Xem trước PDF đã ký (inline)' })
  async preview(@Param('id') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.contractsService.getSignedPdf(
      Number(id),
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  /**
   * Webhook Documenso. Verify header X-Documenso-Secret (plain string)
   * bằng so sánh constant-time. KHÔNG phải HMAC.
   */
  @Public()
  @Post('webhook/documenso')
  @ApiOperation({ summary: 'Webhook Documenso (document lifecycle)' })
  async webhook(
    @Headers('x-documenso-secret') receivedSecret: string,
    // Nhận raw object (không qua DTO) — Documenso gửi kèm field thừa (webhookEndpoint)
    // mà global ValidationPipe (forbidNonWhitelisted) sẽ chặn → 400. Validate thủ công.
    @Body() body: Record<string, any>,
  ) {
    const secret = this.configService.get<string>('DOCUMENSO_WEBHOOK_SECRET');
    if (!secret) {
      throw new InternalServerErrorException(
        'DOCUMENSO_WEBHOOK_SECRET chưa được cấu hình',
      );
    }
    if (!this.verifySecret(receivedSecret, secret)) {
      this.logger.error('Webhook Documenso verify thất bại', {
        timestamp: new Date().toISOString(),
      });
      throw new UnauthorizedException('Unauthorized');
    }
    if (!body?.event || !body?.payload) {
      throw new BadRequestException('Payload webhook không hợp lệ');
    }
    return this.contractsService.handleWebhook(body as DocumensoWebhookDto);
  }

  private verifySecret(received: string, expected: string): boolean {
    if (!received) return false;
    try {
      const a = Buffer.from(received);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** Trả về trang HTML thuần (dùng cho email action pages). */
  private htmlPage(
    title: string,
    message: string,
    type: 'success' | 'error' | 'neutral',
  ): string {
    const colors: Record<
      string,
      { bg: string; text: string; border: string; icon: string }
    > = {
      success: { bg: '#f0fdf4', text: '#166534', border: '#bbf7d0', icon: '✓' },
      error: { bg: '#fef2f2', text: '#991b1b', border: '#fecaca', icon: '✗' },
      neutral: { bg: '#f9fafb', text: '#374151', border: '#e5e7eb', icon: 'ℹ' },
    };
    const c = colors[type] || colors.neutral;
    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;
       min-height:100vh;margin:0;background:#f9fafb}
  .card{background:#fff;border-radius:12px;padding:40px;max-width:480px;width:90%;
        box-shadow:0 4px 24px rgba(0,0,0,0.08);text-align:center}
  .icon{width:56px;height:56px;border-radius:50%;display:inline-flex;align-items:center;
        justify-content:center;font-size:28px;margin-bottom:20px;
        background:${c.bg};color:${c.text};border:2px solid ${c.border}}
  h1{color:#111;font-size:22px;margin:0 0 12px}
  p{color:#444;font-size:15px;line-height:1.6;margin:0}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${c.icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
  }

  /** Trang xác nhận có form POST (chống prefetch của email scanner). */
  private htmlConfirmPage(opts: {
    title: string;
    desc: string;
    btnColor: string;
    btnText: string;
    formAction: string;
  }): string {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title}</title>
<style>
  body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;
       min-height:100vh;margin:0;background:#f3f4f6}
  .card{background:#fff;border-radius:12px;padding:40px;max-width:500px;width:90%;
        box-shadow:0 4px 24px rgba(0,0,0,0.1);text-align:center}
  h1{color:#111;font-size:22px;margin:0 0 14px}
  p{color:#444;font-size:15px;line-height:1.6;margin:0 0 28px}
  .btn{display:inline-block;background:${opts.btnColor};color:#fff;text-decoration:none;
        padding:14px 32px;border-radius:8px;font-weight:bold;font-size:16px;cursor:pointer;
        border:none;width:100%;box-sizing:border-box}
  .btn:hover{opacity:0.9}
  .cancel{display:block;margin-top:14px;color:#6b7280;font-size:13px;text-decoration:none}
  .cancel:hover{text-decoration:underline}
</style>
</head>
<body>
  <div class="card">
    <h1>${opts.title}</h1>
    <p>${opts.desc}</p>
    <form method="POST" action="${opts.formAction}">
      <button type="submit" class="btn">${opts.btnText}</button>
    </form>
    <a href="/" class="cancel">← Quay lại trang chủ</a>
  </div>
</body>
</html>`;
  }
}
