import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { CashFlowGroupsService } from './cashflow-groups.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Cash Flow Groups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cashflow-groups')
export class CashFlowGroupsController {
  constructor(private service: CashFlowGroupsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all cash flow groups' })
  findAll(@Query('isReceipt') isReceipt?: string) {
    const isReceiptBool =
      isReceipt === 'true' ? true : isReceipt === 'false' ? false : undefined;
    return this.service.findAll(isReceiptBool);
  }

  @Post()
  @ApiOperation({ summary: 'Create cash flow group' })
  create(
    @Body() data: { name: string; description?: string; isReceipt: boolean },
  ) {
    return this.service.create(data);
  }
}
