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

  @Get(':id')
  @RequirePermissions('contracts:view')
  @ApiOperation({ summary: 'Chi tiết hợp đồng' })
  async findOne(@Param('id') id: string) {
    return this.contractsService.findOne(Number(id));
  }

  @Post('from-template')
  @RequirePermissions('contracts:create')
  @ApiOperation({ summary: 'Tạo & gửi hợp đồng từ template Documenso' })
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

  /**
   * Webhook Documenso. Verify header X-Documenso-Secret (plain string)
   * bằng so sánh constant-time. KHÔNG phải HMAC.
   */
  @Public()
  @Post('webhook/documenso')
  @ApiOperation({ summary: 'Webhook Documenso (document lifecycle)' })
  async webhook(
    @Headers('x-documenso-secret') receivedSecret: string,
    @Body() dto: DocumensoWebhookDto,
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
    if (!dto?.event || !dto?.payload) {
      throw new BadRequestException('Payload webhook không hợp lệ');
    }
    return this.contractsService.handleWebhook(dto);
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
