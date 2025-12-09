import {
  Controller,
  Post,
  Get,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ImportService } from './import.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('import')
export class ImportController {
  constructor(private importService: ImportService) {}

  @Post('products')
  @RequirePermissions('products.create')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Import products from Excel' })
  async importProducts(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    if (
      ![
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
      ].includes(file.mimetype)
    ) {
      throw new BadRequestException('Only Excel files are allowed');
    }

    return this.importService.importProducts(file);
  }

  @Post('customers')
  @RequirePermissions('customers.create')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Import customers from Excel' })
  async importCustomers(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    if (
      ![
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
      ].includes(file.mimetype)
    ) {
      throw new BadRequestException('Only Excel files are allowed');
    }

    return this.importService.importCustomers(file);
  }

  @Get('templates/products')
  @ApiOperation({ summary: 'Download products import template' })
  async downloadProductsTemplate(@Res() res: Response) {
    const buffer = await this.importService.generateProductsTemplate();

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=products_template.xlsx',
    );

    res.send(buffer);
  }

  @Get('templates/customers')
  @ApiOperation({ summary: 'Download customers import template' })
  async downloadCustomersTemplate(@Res() res: Response) {
    const buffer = await this.importService.generateCustomersTemplate();

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=customers_template.xlsx',
    );

    res.send(buffer);
  }
}
