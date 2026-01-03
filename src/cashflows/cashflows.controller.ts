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
} from '@nestjs/common';
import { CashFlowsService } from './cashflows.service';
import {
  CreateCashFlowDto,
  UpdateCashFlowDto,
  CashFlowQueryDto,
  CreatePaymentDto,
} from './dto';

@Controller('cashflows')
export class CashFlowsController {
  constructor(private cashFlowsService: CashFlowsService) {}

  @Get()
  findAll(@Query() query: CashFlowQueryDto) {
    return this.cashFlowsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.cashFlowsService.findOne(+id);
  }

  @Post()
  create(@Body() dto: CreateCashFlowDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.create(dto, userId);
  }

  @Post('payments')
  createPayment(@Body() dto: CreatePaymentDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.cashFlowsService.createPaymentFromInvoice(dto, userId);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCashFlowDto) {
    return this.cashFlowsService.update(+id, dto);
  }

  @Delete(':id')
  cancel(@Param('id') id: string) {
    return this.cashFlowsService.cancel(+id);
  }

  @Get('opening-balance')
  getOpeningBalance(@Query() query: any) {
    return this.cashFlowsService.getOpeningBalance(query);
  }
}
