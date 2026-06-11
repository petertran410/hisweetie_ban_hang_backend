import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  Res,
} from '@nestjs/common';
import { CashFlowsService } from './cashflows.service';
import {
  CreateCashFlowDto,
  UpdateCashFlowDto,
  CashFlowQueryDto,
  CreatePaymentDto,
  CreateCustomerPaymentDto,
  CreateSupplierPaymentDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { Response } from 'express';

@ApiTags('Cash Flows')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cashflows')
export class CashFlowsController {
  constructor(private cashFlowsService: CashFlowsService) {}

  @Get('opening-balance')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'Get opening balance' })
  getOpeningBalance(@Query() query: any) {
    return this.cashFlowsService.getOpeningBalance(query);
  }

  @Get('summary')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({
    summary: 'Tổng thu/chi toàn bộ tập đã lọc (không phân trang)',
  })
  getSummary(@Query() query: CashFlowQueryDto, @CurrentUser() user: any) {
    return this.cashFlowsService.getSummary(query, user);
  }

  @Get()
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'Get all cash flows' })
  findAll(@Query() query: CashFlowQueryDto, @CurrentUser() user: any) {
    return this.cashFlowsService.findAll(query, user);
  }

  @Get('export')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'Xuất Excel sổ quỹ tổng quan' })
  async exportOverview(@Query() query: CashFlowQueryDto, @Res() res: Response) {
    const ts = Date.now();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=SoQuy_TongQuan_${ts}.xlsx`,
    );
    await this.cashFlowsService.exportOverview(query, res);
  }

  @Get(':id')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'Get cash flow by ID' })
  findOne(@Param('id') id: string) {
    return this.cashFlowsService.findOne(+id);
  }

  @Get(':id/invoice-payments')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'Get invoice payments related to cash flow' })
  getRelatedInvoicePayments(@Param('id') id: string) {
    return this.cashFlowsService.getRelatedInvoicePayments(+id);
  }

  @Post()
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Create cash flow' })
  create(@Body() dto: CreateCashFlowDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.create(dto, userId);
  }

  @Post('payments')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Create payment from invoice' })
  createPayment(@Body() dto: CreatePaymentDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.createPaymentFromInvoice(dto, userId);
  }

  @Post('customer-payments')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Create customer payment for multiple invoices' })
  createCustomerPayment(
    @Body() dto: CreateCustomerPaymentDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.createCustomerPayment(dto, userId);
  }

  @Post('supplier-payments')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({
    summary:
      'Trả tiền NCC bulk cho nhiều phiếu nhập hàng - đối xứng customer-payments',
  })
  createSupplierPayment(
    @Body() dto: CreateSupplierPaymentDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.createSupplierPayment(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('cash_flows:update')
  @ApiOperation({ summary: 'Update cash flow' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCashFlowDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('cash_flows:delete')
  @ApiOperation({ summary: 'Cancel cash flow' })
  cancel(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.cancel(+id, userId);
  }
}
