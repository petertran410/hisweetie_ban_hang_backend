import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ExportService } from './export.service';
import { Type } from 'class-transformer';
import { IsDate, IsOptional } from 'class-validator';

class ExportQueryDto {
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  dateFrom?: Date;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  dateTo?: Date;
}

@Controller('export')
export class ExportController {
  constructor(private exportService: ExportService) {}

  @Get('products')
  async exportProducts(@Res() res: Response) {
    const buffer = await this.exportService.exportProducts();

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=products_${Date.now()}.xlsx`,
    );

    res.send(buffer);
  }

  @Get('orders')
  async exportOrders(@Query() query: ExportQueryDto, @Res() res: Response) {
    const dateFrom =
      query.dateFrom ||
      new Date(new Date().setMonth(new Date().getMonth() - 1));
    const dateTo = query.dateTo || new Date();

    const buffer = await this.exportService.exportOrders(dateFrom, dateTo);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=orders_${Date.now()}.xlsx`,
    );

    res.send(buffer);
  }

  @Get('customers')
  async exportCustomers(@Res() res: Response) {
    const buffer = await this.exportService.exportCustomers();

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=customers_${Date.now()}.xlsx`,
    );

    res.send(buffer);
  }
}
