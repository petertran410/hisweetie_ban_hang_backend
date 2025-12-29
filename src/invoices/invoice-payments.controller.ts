import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
} from '@nestjs/common';
import { InvoicePaymentsService } from './invoice-payments.service';
import { CreateInvoicePaymentDto } from './dto';

@Controller('invoice-payments')
export class InvoicePaymentsController {
  constructor(private invoicePaymentsService: InvoicePaymentsService) {}

  @Post()
  create(@Body() dto: CreateInvoicePaymentDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.invoicePaymentsService.create(dto, userId);
  }

  @Get('invoice/:invoiceId')
  findAllByInvoice(@Param('invoiceId') invoiceId: string) {
    return this.invoicePaymentsService.findAllByInvoice(+invoiceId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.invoicePaymentsService.remove(+id);
  }
}
