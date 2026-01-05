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
} from '@nestjs/common';
import { CashFlowsService } from './cashflows.service';
import {
  CreateCashFlowDto,
  UpdateCashFlowDto,
  CashFlowQueryDto,
  CreatePaymentDto,
  CreateCustomerPaymentDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Cash Flows')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cashflows')
export class CashFlowsController {
  constructor(private cashFlowsService: CashFlowsService) {}

  @Get('opening-balance')
  @ApiOperation({ summary: 'Get opening balance' })
  getOpeningBalance(@Query() query: any) {
    return this.cashFlowsService.getOpeningBalance(query);
  }

  @Get()
  @ApiOperation({ summary: 'Get all cash flows' })
  findAll(@Query() query: CashFlowQueryDto) {
    return this.cashFlowsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get cash flow by ID' })
  findOne(@Param('id') id: string) {
    return this.cashFlowsService.findOne(+id);
  }

  @Post()
  @ApiOperation({ summary: 'Create cash flow' })
  create(@Body() dto: CreateCashFlowDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.create(dto, userId);
  }

  @Post('payments')
  @ApiOperation({ summary: 'Create payment from invoice' })
  createPayment(@Body() dto: CreatePaymentDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.createPaymentFromInvoice(dto, userId);
  }

  @Post('customer-payments')
  @ApiOperation({ summary: 'Create customer payment for multiple invoices' })
  createCustomerPayment(
    @Body() dto: CreateCustomerPaymentDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.createCustomerPayment(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update cash flow' })
  update(@Param('id') id: string, @Body() dto: UpdateCashFlowDto) {
    return this.cashFlowsService.update(+id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel cash flow' })
  cancel(@Param('id') id: string) {
    return this.cashFlowsService.cancel(+id);
  }
}
