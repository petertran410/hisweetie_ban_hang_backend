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
} from '@nestjs/common';
import { PackingSlipsService } from './packing-slips.service';
import {
  CreatePackingSlipDto,
  UpdatePackingSlipDto,
  PackingSlipQueryDto,
  CheckInvoicesDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Packing Slips')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('packing-slips')
export class PackingSlipsController {
  constructor(private packingSlipsService: PackingSlipsService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách báo đơn' })
  findAll(@Query() query: PackingSlipQueryDto) {
    return this.packingSlipsService.findAll(query);
  }

  @Post('check-invoices')
  @ApiOperation({ summary: 'Kiểm tra hóa đơn đã có giao hàng chưa' })
  checkInvoices(@Body() dto: CheckInvoicesDto) {
    return this.packingSlipsService.checkInvoices(dto.invoiceIds);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết báo đơn theo ID' })
  findOne(@Param('id') id: string) {
    return this.packingSlipsService.findOne(+id);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo mới báo đơn' })
  create(@Body() dto: CreatePackingSlipDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingSlipsService.create(dto, userId);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePackingSlipDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.packingSlipsService.update(+id, dto, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa báo đơn' })
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingSlipsService.remove(+id, userId);
  }
}
