import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { StockAuditsService } from './stock-audits.service';
import {
  CreateStockAuditDto,
  UpdateStockAuditDto,
  StockAuditQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Stock Audits')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stock-audits')
export class StockAuditsController {
  constructor(private service: StockAuditsService) {}

  @Get()
  @RequirePermissions('stock_audits:view')
  findAll(@Query() query: StockAuditQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('stock_audits:view')
  findOne(@Param('id') id: string) {
    return this.service.findOne(+id);
  }

  @Post()
  @RequirePermissions('stock_audits:create')
  create(@Body() dto: CreateStockAuditDto, @CurrentUser() user: any) {
    return this.service.create(dto, user.id);
  }

  // Preview tồn tại thời điểm (phục vụ UI form khi đổi checkDate / lùi ngày)
  @Post('preview-stock')
  @RequirePermissions('stock_audits:view')
  previewStock(
    @Body()
    body: { branchId: number; productIds: number[]; checkDate: string },
  ) {
    return this.service.previewStockAtDate(
      body.branchId,
      body.productIds || [],
      body.checkDate,
    );
  }

  @Put(':id')
  @RequirePermissions('stock_audits:update')
  update(@Param('id') id: string, @Body() dto: UpdateStockAuditDto) {
    return this.service.update(+id, dto);
  }

  @Put(':id/complete')
  @RequirePermissions('stock_audits:update')
  complete(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.complete(+id, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('stock_audits:update')
  cancel(@Param('id') id: string) {
    return this.service.cancel(+id);
  }
}
