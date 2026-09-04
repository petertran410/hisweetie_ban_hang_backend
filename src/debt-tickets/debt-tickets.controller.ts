import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { DebtTicketsService } from './debt-tickets.service';
import {
  CreateDebtTicketDto,
  UpdateDebtTicketDto,
  UpdateDebtTicketLineDto,
  CloseDebtTicketDto,
  AddTicketCustomersDto,
  DebtTicketQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('DebtTickets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('debt-tickets')
export class DebtTicketsController {
  constructor(private debtTicketsService: DebtTicketsService) {}

  @Get()
  @RequirePermissions('debt_tickets:view')
  @ApiOperation({ summary: 'Danh sách phiếu thu hồi nợ' })
  findAll(@Query() query: DebtTicketQueryDto) {
    return this.debtTicketsService.findAll(query);
  }

  @Post()
  @RequirePermissions('debt_tickets:create')
  @ApiOperation({ summary: 'Tạo phiếu thu hồi nợ' })
  create(@Body() dto: CreateDebtTicketDto, @Req() req: any) {
    return this.debtTicketsService.create(dto, req.user?.id);
  }

  @Get(':id')
  @RequirePermissions('debt_tickets:view')
  @ApiOperation({ summary: 'Chi tiết phiếu thu hồi nợ' })
  findOne(@Param('id') id: string) {
    return this.debtTicketsService.findOne(+id);
  }

  @Patch(':id')
  @RequirePermissions('debt_tickets:update')
  @ApiOperation({ summary: 'Cập nhật phiếu / chuyển bước xử lý' })
  update(@Param('id') id: string, @Body() dto: UpdateDebtTicketDto) {
    return this.debtTicketsService.update(+id, dto);
  }

  @Post(':id/customers')
  @RequirePermissions('debt_tickets:update')
  @ApiOperation({ summary: 'Thêm khách vào phiếu' })
  addCustomers(@Param('id') id: string, @Body() dto: AddTicketCustomersDto) {
    return this.debtTicketsService.addCustomers(+id, dto);
  }

  @Patch(':id/customers/:customerId')
  @RequirePermissions('debt_tickets:update')
  @ApiOperation({
    summary:
      'Cập nhật dòng khách (số tiền tối thiểu, số khách xác nhận, ghi chú)',
  })
  updateLine(
    @Param('id') id: string,
    @Param('customerId') customerId: string,
    @Body() dto: UpdateDebtTicketLineDto,
  ) {
    return this.debtTicketsService.updateLine(+id, +customerId, dto);
  }

  @Delete(':id/customers/:customerId')
  @RequirePermissions('debt_tickets:update')
  @ApiOperation({ summary: 'Xóa khách khỏi phiếu' })
  removeCustomer(
    @Param('id') id: string,
    @Param('customerId') customerId: string,
  ) {
    return this.debtTicketsService.removeCustomer(+id, +customerId);
  }

  @Post(':id/close')
  @RequirePermissions('debt_tickets:cancel')
  @ApiOperation({
    summary:
      'Kết thúc phiếu thủ công — DONE (đã xong) hoặc ENDED (dừng). Bắt buộc nêu lý do.',
  })
  close(
    @Param('id') id: string,
    @Body() dto: CloseDebtTicketDto,
    @Req() req: any,
  ) {
    return this.debtTicketsService.close(+id, dto, req.user?.id);
  }

  @Post(':id/cancel')
  @RequirePermissions('debt_tickets:cancel')
  @ApiOperation({ summary: 'Dừng phiếu (ENDED) — không thu được' })
  cancel(
    @Param('id') id: string,
    @Body() dto: CloseDebtTicketDto,
    @Req() req: any,
  ) {
    return this.debtTicketsService.cancel(+id, dto, req.user?.id);
  }
}
