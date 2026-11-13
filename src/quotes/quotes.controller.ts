import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { requestHasPermission } from '../auth/request-permissions';
import {
  QuoteListQueryDto,
  QuotePayloadDto,
  QuoteStatusDto,
  QuoteTemplateActiveDto,
  QuoteTemplatePayloadDto,
} from './dto/quote.dto';
import { QuoteActor, QuotesService } from './quotes.service';
import { QuoteTemplatesService } from './quote-templates.service';
import { QuoteExcelService } from './quote-excel.service';
import { QUOTES_VIEW_ALL, QuoteStatus } from './quotes.constants';

/** Request sau JwtAuthGuard (+ effectivePermissions do PermissionsGuard gắn). */
type AuthReq = { user: { id: number; name: string } };

@ApiTags('Quotes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quotes')
export class QuotesController {
  constructor(
    private readonly service: QuotesService,
    private readonly excel: QuoteExcelService,
  ) {}

  // Không có quotes:view_all (Sale) → chỉ báo giá mình tạo; Trưởng Bộ Phận Sale có view_all → mọi báo giá
  private actor(req: AuthReq): QuoteActor {
    return {
      id: req.user.id,
      name: req.user.name,
      ownOnly: !requestHasPermission(req, QUOTES_VIEW_ALL),
    };
  }

  @Get()
  @RequirePermissions('quotes:view')
  list(@Query() q: QuoteListQueryDto, @Req() req: AuthReq) {
    return this.service.list(q, this.actor(req));
  }

  @Get(':id')
  @RequirePermissions('quotes:view')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: AuthReq) {
    return this.service.get(id, this.actor(req));
  }

  /** File .xlsx theo bố cục sheet báo giá tổng hợp. */
  @Get(':id/export/excel')
  @RequirePermissions('quotes:view')
  async exportExcel(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthReq,
    @Res() res: Response,
  ) {
    const quote = await this.service.get(id, this.actor(req));
    const buf = await this.excel.build(quote);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Bao-gia-${quote.code}.xlsx"`,
    );
    res.send(buf);
  }

  @Post()
  @RequirePermissions('quotes:create')
  create(@Body() dto: QuotePayloadDto, @Req() req: AuthReq) {
    return this.service.create(dto, this.actor(req));
  }

  /** Nhân bản / "Dùng mẫu này" từ Thư viện. */
  @Post(':id/duplicate')
  @RequirePermissions('quotes:create')
  duplicate(@Param('id', ParseIntPipe) id: number, @Req() req: AuthReq) {
    return this.service.duplicate(id, this.actor(req));
  }

  @Put(':id')
  @RequirePermissions('quotes:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: QuotePayloadDto,
    @Req() req: AuthReq,
  ) {
    return this.service.update(id, dto, this.actor(req));
  }

  @Patch(':id/status')
  @RequirePermissions('quotes:update')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: QuoteStatusDto,
    @Req() req: AuthReq,
  ) {
    return this.service.setStatus(
      id,
      dto.status as QuoteStatus,
      this.actor(req),
    );
  }

  /** Chỉ báo giá Nháp. */
  @Delete(':id')
  @RequirePermissions('quotes:update')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: AuthReq) {
    return this.service.remove(id, this.actor(req));
  }
}

@ApiTags('Quote templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quote-templates')
export class QuoteTemplatesController {
  constructor(private readonly service: QuoteTemplatesService) {}

  // Sale tạo báo giá cũng cần danh sách mẫu
  @Get()
  @RequireAnyPermission('quote_templates:view', 'quotes:view')
  list() {
    return this.service.list();
  }

  @Post()
  @RequirePermissions('quote_templates:create')
  create(@Body() dto: QuoteTemplatePayloadDto, @Req() req: AuthReq) {
    return this.service.create(dto, req.user.id);
  }

  @Put(':id')
  @RequirePermissions('quote_templates:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: QuoteTemplatePayloadDto,
    @Req() req: AuthReq,
  ) {
    return this.service.update(id, dto, req.user.id);
  }

  @Patch(':id/default')
  @RequirePermissions('quote_templates:update')
  setDefault(@Param('id', ParseIntPipe) id: number, @Req() req: AuthReq) {
    return this.service.setDefault(id, req.user.id);
  }

  @Patch(':id/active')
  @RequirePermissions('quote_templates:update')
  setActive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: QuoteTemplateActiveDto,
    @Req() req: AuthReq,
  ) {
    return this.service.setActive(id, dto.isActive, req.user.id);
  }
}
