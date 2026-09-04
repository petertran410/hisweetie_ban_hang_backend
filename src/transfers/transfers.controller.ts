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
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Transfers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transfers')
export class TransfersController {
  constructor(private transfersService: TransfersService) {}

  @Get()
  @RequirePermissions('transfers:view')
  findAll(@Query() query: TransferQueryDto) {
    return this.transfersService.findAll(query);
  }

  @Get('export')
  @RequirePermissions('transfers:export')
  async export(@Query() query: TransferQueryDto, @Res() res: Response) {
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

    await this.transfersService.exportTransfers(query, res);
  }

  @Get('export-detail')
  @RequirePermissions('transfers:export')
  async exportDetail(@Query() query: TransferQueryDto, @Res() res: Response) {
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

    await this.transfersService.exportTransfersDetail(query, res);
  }

  @Get('planning-summary')
  @RequirePermissions('transfers:view')
  getPlanningSummary(@Query() query: TransferPlanningQueryDto) {
    return this.transfersService.getPlanningSummary(query);
  }

  @Get('draft-candidates')
  @RequirePermissions('transfers:view')
  getDraftCandidates() {
    return this.transfersService.getDraftCandidates();
  }

  @Get('in-transit-by-product')
  @RequirePermissions('transfers:view')
  getInTransitByProduct(@Query() query: ProductTransferQueryDto) {
    return this.transfersService.getTransfersByProductForPlanning(
      query.productId,
      2,
    );
  }

  @Get('pending-by-product')
  @RequirePermissions('transfers:view')
  getPendingByProduct(@Query() query: ProductTransferQueryDto) {
    return this.transfersService.getTransfersByProductForPlanning(
      query.productId,
      1,
    );
  }

  @Get(':id')
  @RequirePermissions('transfers:view')
  findOne(@Param('id') id: string) {
    return this.transfersService.findOne(+id);
  }

  @Post()
  @RequirePermissions('transfers:create')
  create(@Body() dto: CreateTransferDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.transfersService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('transfers:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTransferDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.transfersService.update(+id, dto, userId);
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
  confirmShortage(
    @Param('id') id: string,
    @Body() dto: ConfirmShortageDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.transfersService.confirmShortage(+id, dto, userId);
  }
}
