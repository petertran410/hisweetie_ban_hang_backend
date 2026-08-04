import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Put,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { StockConditionTransfersService } from './stock-condition-transfers.service';
import {
  CreateStockConditionTransferDto,
  StockConditionTransferQueryDto,
  UpdateStockConditionTransferDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Stock Condition Transfers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stock-condition-transfers')
export class StockConditionTransfersController {
  constructor(private service: StockConditionTransfersService) {}

  @Get()
  @RequirePermissions('stock_condition_transfers:view')
  findAll(@Query() query: StockConditionTransferQueryDto) {
    return this.service.findAll(query);
  }

  @Get('export')
  @RequirePermissions('stock_condition_transfers:export')
  async export(
    @Query() query: StockConditionTransferQueryDto,
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
      `attachment; filename=ChuyenLoaiTon_${ts}.xlsx`,
    );

    await this.service.exportTransfers(query, res);
  }

  @Get(':id')
  @RequirePermissions('stock_condition_transfers:view')
  findOne(@Param('id') id: string) {
    return this.service.findOne(+id);
  }

  @Post()
  @RequirePermissions('stock_condition_transfers:create')
  create(
    @Body() dto: CreateStockConditionTransferDto,
    @CurrentUser() user: any,
  ) {
    return this.service.create(dto, user.id);
  }

  // Xem trước ảnh hưởng khi sửa: hóa đơn nào đã bán từ lô cận date hiện tại.
  // Đặt TRƯỚC route ':id' động khác cùng method? Không cần: path khác nhau rõ ràng.
  @Get(':id/edit-impact')
  @RequirePermissions('stock_condition_transfers:view')
  getEditImpact(@Param('id') id: string) {
    return this.service.getEditImpact(+id);
  }

  // Sửa phiếu (kể cả đã duyệt): NSX, số lượng, ghi chú.
  @Put(':id')
  @RequirePermissions('stock_condition_transfers:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStockConditionTransferDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(+id, dto, user?.id);
  }

  @Put(':id/approve')
  @RequirePermissions('stock_condition_transfers:approve')
  approve(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.approve(+id, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('stock_condition_transfers:cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.cancel(+id, user?.id);
  }
}
