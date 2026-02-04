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

@ApiTags('Invoices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private invoicesService: InvoicesService) {}

  @Get()
  findAll(@Query() query: InvoiceQueryDto) {
    return this.invoicesService.findAll(query);
  }

  @Get('unpaid-by-partner')
  @ApiOperation({ summary: 'Lấy hóa đơn chưa thanh toán đầy đủ theo đối tác' })
  getUnpaidByPartner(
    @Query('partnerId') partnerId: string,
    @Query('partnerType') partnerType: string,
  ) {
    return this.invoicesService.findUnpaidByPartner(+partnerId, partnerType);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.invoicesService.findOne(+id);
  }

  @Post()
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: any) {
    return this.invoicesService.create(dto, user.id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.invoicesService.update(+id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.invoicesService.remove(+id);
  }

  @Post('from-order/:orderId')
  createFromOrder(
    @Param('orderId') orderId: string,
    @Body() dto: CreateInvoiceFromOrderDto,
    @CurrentUser() user: any,
  ) {
    return this.invoicesService.createFromOrder(+orderId, dto, user.id);
  }

  @Post('link-order/:invoiceId/:orderId')
  async linkOrderToInvoice(
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
    @Param('orderId', ParseIntPipe) orderId: number,
  ) {
    return this.invoicesService.linkOrderToInvoice(invoiceId, orderId);
  }
}
