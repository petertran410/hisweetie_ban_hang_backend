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
  CostApplicationPreviewQueryDto,
  CancelSentProductionDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';
import { ProductionCostHistoryService } from './production-cost-history.service';
import { ProductionCostService } from './production-cost.service';
import { ProductionCostHistoryQueryDto } from './dto/production-cost-history.dto';

@ApiTags('Productions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('productions')
export class ProductionsController {
  constructor(
    private productionsService: ProductionsService,
    private costHistory: ProductionCostHistoryService,
    private costService: ProductionCostService,
  ) {}

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

  @Get('cost-history')
  @RequirePermissions('productions:view')
  history(@Query() query: ProductionCostHistoryQueryDto) {
    return this.costHistory.history(query);
  }

  @Get('cost-history/chart')
  @RequirePermissions('productions:view')
  historyChart(@Query() query: ProductionCostHistoryQueryDto) {
    return this.costHistory.history(query, true);
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
      query.processingFee,
    );
  }

  @Post(':id/apply-cost')
  @RequirePermissions('productions:apply_cost')
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

  @Get(':id/cost-application-preview')
  @RequirePermissions('productions:apply_cost')
  applicationPreview(@Param('id') id: string, @Query() query: CostApplicationPreviewQueryDto, @Req() req: any) {
    return this.costService.preview(+id, query.scope, req.user.id);
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

  // ── Đợt nhận thành phẩm của phiếu gửi NSX (dùng mã quyền có sẵn) ─────
  @Put(':id/receipts/:receiptId')
  @RequirePermissions('productions:update')
  updateReceipt(
    @Param('id') id: string,
    @Param('receiptId') receiptId: string,
    @Body() dto: ReceiveProductionDto,
    @Req() req: any,
  ) {
    return this.productionsService.updateReceipt(+id, +receiptId, dto, req.user?.id || 1);
  }

  // Hủy đợt nhận dùng quyền Xóa phiếu sản xuất, giống Hủy phiếu.
  @Post(':id/receipts/:receiptId/cancel')
  @RequirePermissions('productions:delete')
  cancelReceipt(
    @Param('id') id: string,
    @Param('receiptId') receiptId: string,
    @Req() req: any,
  ) {
    return this.productionsService.cancelReceipt(+id, +receiptId, req.user?.id || 1);
  }

  @Post(':id/close-receiving')
  @RequirePermissions('productions:update')
  closeReceiving(@Param('id') id: string, @Req() req: any) {
    return this.productionsService.closeReceiving(+id, req.user?.id || 1);
  }

  @Post(':id/reopen-receiving')
  @RequirePermissions('productions:update')
  reopenReceiving(@Param('id') id: string, @Req() req: any) {
    return this.productionsService.reopenReceiving(+id, req.user?.id || 1);
  }

  @Delete(':id')
  @RequirePermissions('productions:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.productionsService.remove(+id, userId);
  }
}
