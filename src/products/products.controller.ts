import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  @Get()
  @RequirePermissions('products:view')
  findAll(@Query() query: ProductQueryDto) {
    return this.productsService.findAll(query);
  }

  @Get('export')
  @RequirePermissions('products:export')
  async export(
    @Query() query: ProductQueryDto,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=DanhSachSanPham_${timestamp}.xlsx`,
    );

    await this.productsService.exportProducts(query, res);
  }

  @Get(':id/inventory-logs')
  @RequirePermissions('products:view')
  findInventoryLogs(
    @Param('id') id: string,
    @Query('branchId') branchId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.productsService.findInventoryLogs(
      +id,
      branchId ? +branchId : undefined,
      page ? +page : 1,
      limit ? +limit : 5,
    );
  }

  @Get(':id')
  @RequirePermissions('products:view')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('products:create')
  create(@Body() dto: CreateProductDto, @Req() req: any) {
    const userId = req.user?.id;
    return this.productsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('products:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    return this.productsService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('products:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    return this.productsService.remove(+id, userId);
  }

  @Get('low-stock')
  @RequirePermissions('products:view')
  checkLowStock() {
    return this.productsService.checkLowStock();
  }
}
