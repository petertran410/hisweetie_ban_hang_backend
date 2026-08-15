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
import { FactoriesService } from './factories.service';
import { FactoryImportService } from './factory-import.service';
import { CreateFactoryDto, FactoryQueryDto, UpdateFactoryDto } from './dto';

@ApiTags('Factories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('factories')
export class FactoriesController {
  constructor(
    private factoriesService: FactoriesService,
    private importService: FactoryImportService,
  ) {}

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
      'attachment; filename=factory_import_template.xlsx',
    );
    res.send(buffer);
  }

  /** Bước 1: chỉ đọc file và đối chiếu DB, không ghi gì. */
  @Post('import/preview')
  @RequirePermissions('factories:create')
  @UseInterceptors(FileInterceptor('file', FactoriesController.UPLOAD_OPTIONS))
  previewImport(@UploadedFile() file: Express.Multer.File) {
    this.assertExcel(file);
    return this.importService.preview(file);
  }

  /** Bước 2: ghi DB. Từ chối toàn bộ nếu còn dòng lỗi. */
  @Post('import')
  @RequirePermissions('factories:create')
  @UseInterceptors(FileInterceptor('file', FactoriesController.UPLOAD_OPTIONS))
  commitImport(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    this.assertExcel(file);
    return this.importService.commit(file, req.user?.id || 1);
  }

  /**
   * List nhà máy với filter. Permission: factories:view (user tự thêm qua UI).
   * Backward compatible: giữ query `includeInactive` cho code cũ nếu có.
   */
  @Get()
  @RequirePermissions('factories:view')
  findAll(@Query() query: FactoryQueryDto) {
    return this.factoriesService.findAll(query);
  }

  @Get('export')
  @RequirePermissions('factories:view')
  async exportAll(@Query() query: FactoryQueryDto, @Res() res: Response) {
    const buffer = await this.factoriesService.exportAll(query);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename=factories.xlsx');
    res.send(buffer);
  }

  @Get(':id/export')
  @RequirePermissions('factories:view')
  async exportDetail(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const buffer = await this.factoriesService.exportDetail(id);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=factory_${id}_detail.xlsx`,
    );
    res.send(buffer);
  }

  /**
   * Lấy tất cả nhà máy (active) của 1 NCC — dùng cho dropdown trong các form
   * liên quan đến NCC (đặt hàng nhập, sản phẩm...).
   */
  @Get('by-supplier/:supplierId')
  @RequirePermissions('factories:view')
  getBySupplier(@Param('supplierId', ParseIntPipe) supplierId: number) {
    return this.factoriesService.getBySupplier(supplierId);
  }

  /**
   * Danh sách Product gắn nhà máy này (chia theo vai trò primary/backup) —
   * dùng cho trang read-only /san-pham/nha-may/[id]/san-pham.
   */
  @Get(':id/products')
  @RequirePermissions('factories:view')
  getProductsByFactory(@Param('id', ParseIntPipe) id: number) {
    return this.factoriesService.getProductsByFactory(id);
  }

  @Get(':id')
  @RequirePermissions('factories:view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.factoriesService.findOne(id);
  }

  @Post()
  @RequirePermissions('factories:create')
  create(@Body() dto: CreateFactoryDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.factoriesService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('factories:update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateFactoryDto) {
    return this.factoriesService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('factories:delete')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.factoriesService.remove(id);
  }
}
