import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { PdfService } from './pdf.service';

@Controller('pdf')
export class PdfController {
  constructor(private pdfService: PdfService) {}

  @Get('order/:id/invoice')
  async generateInvoice(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.pdfService.generateOrderInvoice(+id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=invoice_${id}.pdf`,
    );

    res.send(buffer);
  }
}
