import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { CashFlowGroupsService } from './cashflow-groups.service';

@Controller('cashflow-groups')
export class CashFlowGroupsController {
  constructor(private service: CashFlowGroupsService) {}

  @Get()
  findAll(@Query('isReceipt') isReceipt?: string) {
    const isReceiptBool =
      isReceipt === 'true' ? true : isReceipt === 'false' ? false : undefined;
    return this.service.findAll(isReceiptBool);
  }

  @Post()
  create(
    @Body() data: { name: string; description?: string; isReceipt: boolean },
  ) {
    return this.service.create(data);
  }
}
