import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { FactoryProductsService } from './factory-products.service';
import { FactoryProductImportService } from './factory-product-import.service';
import {
  CreateFactoryProductDto,
  FactoryProductQueryDto,
  PriceHistorySeriesQueryDto,
  ReferencePricesQueryDto,
  UpdateFactoryProductDto,
} from './dto';

@ApiTags('Factory Products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('factory-products')
export class FactoryProductsController {
  constructor(
    private factoryProductsService: FactoryProductsService,
    private importService: FactoryProductImportService,
  ) {}

  /**
   * Import chỉ nhận .xlsx và giới hạn 10MB — file mapping thực tế chỉ vài trăm
   * dòng nên không cần lớn hơn.
   */
  private static readonly UPLOAD_OPTIONS = {
    limits: { fileSize: 10 * 1024 * 1024 },
  };

  private assertExcel(file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Chưa chọn file');
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (!allowed.includes(file.mimetype))
      throw new BadRequestException('Chỉ chấp nhận file Excel (.xlsx)');
  }

  @Get('import/template')
  @RequirePermissions('factories:view')
  async downloadImportTemplate(@Res() res: Response) {
    const buffer = await this.importService.template();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=factory_product_mapping_template.xlsx',
    );
    res.send(buffer);
  }

  /** Bước 1: chỉ đọc file và đối chiếu DB, không ghi gì. */
  @Post('import/preview')
  @RequirePermissions('factories:create')
  @UseInterceptors(
    FileInterceptor('file', FactoryProductsController.UPLOAD_OPTIONS),
  )
  previewImport(@UploadedFile() file: Express.Multer.File) {
    this.assertExcel(file);
    return this.importService.preview(file);
  }

  /** Bước 2: ghi DB. Từ chối toàn bộ nếu còn dòng lỗi. */
  @Post('import')
  @RequirePermissions('factories:create')
  @UseInterceptors(
    FileInterceptor('file', FactoryProductsController.UPLOAD_OPTIONS),
  )
  commitImport(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    this.assertExcel(file);
    return this.importService.commit(file, req.user.id, req.user.name);
  }

  @Get()
  @RequirePermissions('factories:view')
  findAll(@Query() query: FactoryProductQueryDto) {
    return this.factoryProductsService.findAll(query);
  }

  @Get('reference-prices')
  @RequirePermissions('factories:view')
  getReferencePrices(@Query() query: ReferencePricesQueryDto) {
    return this.factoryProductsService.getReferencePrices(query);
  }

  @Get('price-history/series')
  @RequirePermissions('factories:view')
  getPriceHistorySeries(@Query() query: PriceHistorySeriesQueryDto) {
    return this.factoryProductsService.getPriceHistorySeries(query);
  }

  @Get(':id/price-history')
  @RequirePermissions('factories:view')
  getPriceHistory(@Param('id', ParseIntPipe) id: number) {
    return this.factoryProductsService.getPriceHistory(id);
  }

  @Get(':id')
  @RequirePermissions('factories:view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.factoryProductsService.findOne(id);
  }

  @Post()
  @RequirePermissions('factories:create')
  create(@Body() dto: CreateFactoryProductDto, @Req() req: any) {
    return this.factoryProductsService.create(dto, req.user.id, req.user.name);
  }

  @Put(':id')
  @RequirePermissions('factories:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFactoryProductDto,
    @Req() req: any,
  ) {
    return this.factoryProductsService.update(
      id,
      dto,
      req.user.id,
      req.user.name,
    );
  }

  @Delete(':id')
  @RequirePermissions('factories:delete')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.factoryProductsService.remove(id);
  }
}
