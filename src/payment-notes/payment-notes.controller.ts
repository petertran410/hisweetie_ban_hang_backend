import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { PaymentNotesService } from './payment-notes.service';
import { CreatePaymentNoteDto } from './create-payment-note.dto';

@Controller()
export class PaymentNotesController {
  constructor(private readonly service: PaymentNotesService) {}

  @Post('orders/:id/payment-note')
  createOrder(@Param('id') id: string, @Body() dto: CreatePaymentNoteDto, @Req() req: any) {
    return this.service.createOrderNote(Number(id), dto, req.user?.id || 1);
  }

  @Post('invoices/:id/payment-note')
  createInvoice(@Param('id') id: string, @Body() dto: CreatePaymentNoteDto, @Req() req: any) {
    return this.service.createInvoiceNote(Number(id), dto, req.user?.id || 1);
  }
}
