import {
  Controller,
  Post,
  Get,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Res,
  BadRequestException,
  Query,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ImportService } from './import.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { ImportProductsOptionsDto } from './dto/import-products.dto';

@ApiTags('Import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('import')
export class ImportController {
  constructor(private importService: ImportService) {}

  @Post('products')
  @RequirePermissions('products:create')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Import products from Excel' })
  async importProducts(
    @UploadedFile() file: Express.Multer.File,
    @Query() options: ImportProductsOptionsDto,
    @Req() req: any,
  ) {
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

    // Trích thông tin user + request context để ghi audit log tổng cho file import.
    const user = req.user || {};
    const userContext = {
      userId: Number(user.id) || 1,
      userName: user.name || user.email || 'System',
      branchId: user.branchId ? Number(user.branchId) : undefined,
      branchName: user.branchName,
      ipAddress: req.ip,
      userAgent: req.headers?.['user-agent'],
      requestId: req.headers?.['x-request-id'],
    };

    return this.importService.importProducts(
      file,
      {
        updateStock: options.updateStock ?? false,
        updateDescription: options.updateDescription ?? false,
        updateCost: options.updateCost ?? false,
        branchId: options.branchId,
      },
      userContext,
    );
  }

  @Post('customers')
  @RequirePermissions('customers:create')
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
  async downloadProductsTemplate(
    @Query('branchId') branchId: string,
    @Res() res: Response,
  ) {
    const buffer = await this.importService.generateProductsTemplate(
      branchId ? parseInt(branchId) : undefined,
    );

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

  @Post('price-books')
  @RequirePermissions('products:create')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Import price books from Excel' })
  async importPriceBooks(@UploadedFile() file: Express.Multer.File) {
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

    return this.importService.importPriceBooks(file);
  }

  @Get('templates/price-books')
  @ApiOperation({ summary: 'Download price books import template' })
  async downloadPriceBooksTemplate(@Res() res: Response) {
    const buffer = await this.importService.generatePriceBooksTemplate();

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=price_books_template.xlsx',
    );

    res.send(buffer);
  }

  @Post('invoices')
  @RequirePermissions('invoices:create')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: 'Import invoices from Excel' })
  async importInvoices(
    @UploadedFile() file: Express.Multer.File,
    @Query('branchId') branchId: string,
    @Query('recalculateCustomerDebt') recalculateCustomerDebt: string,
    @Req() req: any,
  ) {
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

    const userId = req.user?.id || 1;

    return this.importService.importInvoices(file, {
      branchId: branchId ? parseInt(branchId) : undefined,
      userId,
      recalculateCustomerDebt: recalculateCustomerDebt === 'true',
    });
  }

  @Get('templates/invoices')
  @ApiOperation({ summary: 'Download invoices import template' })
  async downloadInvoicesTemplate(@Res() res: Response) {
    const buffer = await this.importService.generateInvoicesTemplate();

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=invoices_template.xlsx',
    );

    res.send(buffer);
  }
}
