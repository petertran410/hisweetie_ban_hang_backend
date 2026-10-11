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
import { TransfersService } from './transfers.service';
import {
  CreateTransferDto,
  UpdateTransferDto,
  TransferQueryDto,
  CancelTransferDto,
  ConfirmShortageDto,
  TransferPlanningQueryDto,
  ProductTransferQueryDto,
  SaveTempQuantityDto,
  QuickCreateTransferDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  RequirePermissions,
  RequireAnyPermission,
} from '../auth/decorators/permissions.decorator';
import { requestHasPermission } from '../auth/request-permissions';

const VIEW_PRICE = 'transfers:view_cost_price';

/** Ẩn đơn giá / giá trị của phiếu chuyển khi user thiếu quyền xem giá. */
function stripTransferPrices<T>(transfer: T): T {
  if (!transfer || typeof transfer !== 'object') return transfer;
  const t: any = transfer;
  return {
    ...t,
    totalTransfer: undefined,
    totalReceive: undefined,
    details: Array.isArray(t.details)
      ? t.details.map((d: any) => ({
          ...d,
          sendPrice: undefined,
          receivePrice: undefined,
          totalTransfer: undefined,
          totalReceive: undefined,
        }))
      : t.details,
  };
}

@ApiTags('Transfers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transfers')
export class TransfersController {
  constructor(private transfersService: TransfersService) {}

  @Get()
  @RequirePermissions('transfers:view')
  async findAll(@Query() query: TransferQueryDto, @Req() req: any) {
    const result = await this.transfersService.findAll(query);
    if (requestHasPermission(req, VIEW_PRICE)) return result;
    return { ...result, data: result.data.map(stripTransferPrices) };
  }

  @Get('export')
  @RequirePermissions('transfers:export')
  async export(
    @Query() query: TransferQueryDto,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=ChuyenHang_${ts}.xlsx`,
    );

    await this.transfersService.exportTransfers(
      query,
      res,
      !requestHasPermission(req, VIEW_PRICE),
    );
  }

  @Get('export-detail')
  @RequirePermissions('transfers:export')
  async exportDetail(
    @Query() query: TransferQueryDto,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=ChuyenHang_ChiTiet_${ts}.xlsx`,
    );

    await this.transfersService.exportTransfersDetail(
      query,
      res,
      !requestHasPermission(req, VIEW_PRICE),
    );
  }

  @Get('planning-summary')
  @RequireAnyPermission('transfer_planning:view', 'transfers:view')
  getPlanningSummary(
    @Query() query: TransferPlanningQueryDto,
    @Req() req: any,
  ) {
    return this.transfersService.getPlanningSummary(query, req.user?.id || 1);
  }

  @Put('temp-quantity')
  @RequirePermissions('transfers:create')
  saveTempQuantity(@Body() dto: SaveTempQuantityDto, @Req() req: any) {
    return this.transfersService.saveTempQuantity(dto, req.user?.id || 1);
  }

  @Get('temp-quantities')
  @RequireAnyPermission('transfer_planning:view', 'transfers:view')
  getTempQuantities(@Req() req: any) {
    return this.transfersService.getTempQuantities(req.user?.id || 1);
  }

  @Delete('temp-quantities')
  @RequirePermissions('transfers:create')
  resetTempQuantities(@Req() req: any) {
    return this.transfersService.resetTempQuantities(req.user?.id || 1);
  }

  @Post('quick-create')
  @RequirePermissions('transfers:create')
  quickCreate(@Body() dto: QuickCreateTransferDto, @Req() req: any) {
    return this.transfersService.quickCreateTransfer(dto, req.user?.id || 1);
  }

  @Get('draft-candidates')
  @RequireAnyPermission('transfer_planning:view', 'transfers:view')
  getDraftCandidates() {
    return this.transfersService.getDraftCandidates();
  }

  @Get('in-transit-by-product')
  @RequireAnyPermission('transfer_planning:view', 'transfers:view')
  getInTransitByProduct(@Query() query: ProductTransferQueryDto) {
    return this.transfersService.getTransfersByProductForPlanning(
      query.productId,
      2,
    );
  }

  @Get('pending-by-product')
  @RequireAnyPermission('transfer_planning:view', 'transfers:view')
  getPendingByProduct(@Query() query: ProductTransferQueryDto) {
    return this.transfersService.getTransfersByProductForPlanning(
      query.productId,
      1,
    );
  }

  @Get('promised-hn-by-product')
  @RequireAnyPermission('transfer_planning:view', 'transfers:view')
  getPromisedHNByProduct(@Query() query: ProductTransferQueryDto) {
    return this.transfersService.getPromisedHNByProduct(query.productId);
  }

  @Get('promised-sg-by-product')
  @RequireAnyPermission('transfer_planning:view', 'transfers:view')
  getPromisedSGByProduct(@Query() query: ProductTransferQueryDto) {
    return this.transfersService.getPromisedSGByProduct(query.productId);
  }

  @Get(':id')
  @RequirePermissions('transfers:view')
  async findOne(@Param('id') id: string, @Req() req: any) {
    const transfer = await this.transfersService.findOne(+id);
    return requestHasPermission(req, VIEW_PRICE)
      ? transfer
      : stripTransferPrices(transfer);
  }

  @Post()
  @RequirePermissions('transfers:create')
  async create(@Body() dto: CreateTransferDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    const transfer = await this.transfersService.create(dto, userId);
    return requestHasPermission(req, VIEW_PRICE)
      ? transfer
      : stripTransferPrices(transfer);
  }

  @Put(':id')
  @RequirePermissions('transfers:update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTransferDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    const transfer = await this.transfersService.update(+id, dto, userId);
    return requestHasPermission(req, VIEW_PRICE)
      ? transfer
      : stripTransferPrices(transfer);
  }

  @Delete(':id')
  @RequirePermissions('transfers:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.transfersService.remove(+id, userId);
  }

  @Put(':id/cancel')
  @RequirePermissions('transfers:update')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelTransferDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.transfersService.cancelTransfer(+id, dto, userId);
  }

  /**
   * Xác nhận xử lý chênh lệch nhận hàng (shortage) sau khi kho nhận
   * "Đã nhận". Với mỗi sản phẩm có shortage, chọn:
   * - RETURN_TO_SOURCE: hoàn shortage về kho chuyển (gửi thiếu)
   * - WRITE_OFF: tạo phiếu xuất hủy (hàng thất thoát)
   */
  @Post(':id/confirm-shortage')
  @RequirePermissions('transfers:update')
  async confirmShortage(
    @Param('id') id: string,
    @Body() dto: ConfirmShortageDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    const transfer = await this.transfersService.confirmShortage(
      +id,
      dto,
      userId,
    );
    return requestHasPermission(req, VIEW_PRICE)
      ? transfer
      : stripTransferPrices(transfer);
  }
}
