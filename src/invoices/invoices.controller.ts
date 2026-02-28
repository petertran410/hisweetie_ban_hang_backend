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
  ParseIntPipe,
} from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  InvoiceQueryDto,
  CreateInvoiceFromOrderDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Invoices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private invoicesService: InvoicesService) {}

  @Get()
  @RequirePermissions('invoices:view')
  findAll(@Query() query: InvoiceQueryDto) {
    return this.invoicesService.findAll(query);
  }

  @Get('unpaid-by-partner')
  @RequirePermissions('invoices:view')
  @ApiOperation({ summary: 'Lấy hóa đơn chưa thanh toán đầy đủ theo đối tác' })
  getUnpaidByPartner(
    @Query('partnerId') partnerId: string,
    @Query('partnerType') partnerType: string,
  ) {
    return this.invoicesService.findUnpaidByPartner(+partnerId, partnerType);
  }

  @Get(':id')
  @RequirePermissions('invoices:view')
  findOne(@Param('id') id: string) {
    return this.invoicesService.findOne(+id);
  }

  @Get(':id/payment-history')
  @RequirePermissions('invoices:view')
  async getPaymentHistory(@Param('id', ParseIntPipe) id: number) {
    return this.invoicesService.getPaymentHistory(id);
  }

  @Post()
  @RequirePermissions('invoices:create')
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: any) {
    return this.invoicesService.create(dto, user.id);
  }

  @Put(':id')
  @RequirePermissions('invoices:update')
  update(@Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.invoicesService.update(+id, dto);
  }

  @Delete(':id')
  @RequirePermissions('invoices:delete')
  remove(@Param('id') id: string) {
    return this.invoicesService.remove(+id);
  }

  @Post('from-order/:orderId')
  @RequirePermissions('invoices:update')
  createFromOrder(
    @Param('orderId') orderId: string,
    @Body() dto: CreateInvoiceFromOrderDto,
    @CurrentUser() user: any,
  ) {
    return this.invoicesService.createFromOrder(+orderId, dto, user.id);
  }
}
