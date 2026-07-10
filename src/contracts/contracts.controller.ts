import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Patch,
  Delete,
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
  CreateContractSignerDto,
  UpdateContractSignerDto,
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

  @Get('signers')
  @RequirePermissions('contracts:create')
  @ApiOperation({
    summary:
      'Danh sách người ký BÊN A đang hoạt động (dropdown khi tạo HĐ 2 bên).',
  })
  async listSigners(@Query('refresh') refresh?: string) {
    return this.contractsService.listSigners(refresh === 'true');
  }

  @Post('signers')
  @RequirePermissions('contracts:manage_signers')
  @ApiOperation({ summary: 'Tạo mới người ký hợp đồng (BÊN A) — admin' })
  async createSigner(@Body() dto: CreateContractSignerDto) {
    return this.contractsService.createSigner(dto);
  }

  @Patch('signers/:id')
  @RequirePermissions('contracts:manage_signers')
  @ApiOperation({ summary: 'Cập nhật người ký hợp đồng — admin' })
  async updateSigner(
    @Param('id') id: string,
    @Body() dto: UpdateContractSignerDto,
  ) {
    return this.contractsService.updateSigner(Number(id), dto);
  }

  @Delete('signers/:id')
  @RequirePermissions('contracts:manage_signers')
  @ApiOperation({ summary: 'Ẩn (soft-delete) người ký hợp đồng — admin' })
  async deleteSigner(@Param('id') id: string) {
    return this.contractsService.deleteSigner(Number(id));
  }

  @Get(':id')
  @RequirePermissions('contracts:view')
  @ApiOperation({ summary: 'Chi tiết hợp đồng' })
  async findOne(@Param('id') id: string) {
    return this.contractsService.findOne(Number(id));
  }

  @Post('from-template')
  @RequirePermissions('contracts:create')
  @ApiOperation({ summary: 'Tạo HĐ từ template + gửi mail #1 cho khách' })
  async createFromTemplate(
    @Body() dto: CreateFromTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.contractsService.createFromTemplate(dto, user?.id);
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
  @ApiOperation({ summary: 'Gửi lại mail ký cho khách (Documenso)' })
  async resend(@Param('id') id: string) {
    return this.contractsService.resend(Number(id));
  }

  @Post(':id/sync')
  @RequirePermissions('contracts:view')
  @ApiOperation({
    summary:
      'Đồng bộ trạng thái HĐ từ Documenso (khi webhook miss / kẹt SENT sau khi khách ký)',
  })
  async sync(@Param('id') id: string) {
    return this.contractsService.syncFromDocumenso(Number(id));
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
}