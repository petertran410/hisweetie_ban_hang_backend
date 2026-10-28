import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ProductionsService } from './productions.service';
import {
  CreateProductionDto,
  UpdateProductionDto,
  ProductionQueryDto,
  SendProductionDto,
  ReceiveProductionDto,
  ApplyProductionCostDto,
  CostPreviewQueryDto,
  CancelSentProductionDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('Productions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('productions')
export class ProductionsController {
  constructor(private productionsService: ProductionsService) {}

  @Get()
  @RequirePermissions('productions:view')
  findAll(@Query() query: ProductionQueryDto) {
    return this.productionsService.findAll(query);
  }

  @Get('export')
  @RequirePermissions('productions:export')
  async export(@Query() query: ProductionQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=SanXuat_${ts}.xlsx`,
    );

    await this.productionsService.exportProductions(query, res);
  }

  @Get('export-detail')
  @RequirePermissions('productions:export')
  async exportDetail(@Query() query: ProductionQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=SanXuat_ChiTiet_${ts}.xlsx`,
    );

    await this.productionsService.exportProductionsDetail(query, res);
  }

  @Get(':id')
  @RequirePermissions('productions:view')
  findOne(@Param('id') id: string) {
    return this.productionsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('productions:create')
  create(@Body() dto: CreateProductionDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.productionsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('productions:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductionDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.productionsService.update(+id, dto, userId);
  }

  // ── Gửi sản xuất ở nhà máy ngoài ──────────────────────────────────────
  @Post(':id/send')
  @RequirePermissions('productions:update')
  send(
    @Param('id') id: string,
    @Body() dto: SendProductionDto,
    @Req() req: any,
  ) {
    return this.productionsService.sendToFactory(+id, dto, req.user?.id || 1);
  }

  @Post(':id/receive')
  @RequirePermissions('productions:update')
  receive(
    @Param('id') id: string,
    @Body() dto: ReceiveProductionDto,
    @Req() req: any,
  ) {
    return this.productionsService.receiveFromFactory(
      +id,
      dto,
      req.user?.id || 1,
    );
  }

  @Get(':id/cost-preview')
  @RequirePermissions('productions:view')
  costPreview(@Param('id') id: string, @Query() query: CostPreviewQueryDto) {
    return this.productionsService.getFactoryCostPreview(
      +id,
      query.receivedQuantity,
    );
  }

  @Post(':id/apply-cost')
  @RequirePermissions('productions:update')
  applyCost(
    @Param('id') id: string,
    @Body() dto: ApplyProductionCostDto,
    @Req() req: any,
  ) {
    return this.productionsService.applyFactoryCost(
      +id,
      dto,
      req.user?.id || 1,
    );
  }

  // Phiếu đã gửi / hoàn thành chỉ admin hủy được: dùng quyền Xóa phiếu sản
  // xuất (vốn chỉ cấp cho admin) thay vì thêm quyền mới.
  @Post(':id/cancel-sent')
  @RequirePermissions('productions:delete')
  cancelSent(
    @Param('id') id: string,
    @Body() dto: CancelSentProductionDto,
    @Req() req: any,
  ) {
    return this.productionsService.cancelSentProduction(
      +id,
      dto,
      req.user?.id || 1,
    );
  }

  @Delete(':id')
  @RequirePermissions('productions:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.productionsService.remove(+id, userId);
  }
}
