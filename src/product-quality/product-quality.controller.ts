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
  Res,
  Headers,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ProductQualityService } from './product-quality.service';
import {
  ProductQualityQueryDto,
  CreateProductQualityTicketDto,
  UpdateProductQualityTicketDto,
  AssignProductQualityTicketDto,
  UpdateProductQualityTaskDto,
  CloseProductQualityTicketDto,
  UpsertRoutingConfigDto,
  UpsertDepartmentMemberDto,
  LarkImportDto,
} from './dto';

@ApiTags('Product Quality')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('product-quality-tickets')
export class ProductQualityController {
  constructor(private readonly service: ProductQualityService) {}

  @Get()
  @RequirePermissions('product_quality:view')
  @ApiOperation({ summary: 'Danh sách phiếu sự cố chất lượng' })
  findAll(@Query() query: ProductQualityQueryDto, @CurrentUser() user: any) {
    return this.service.findAll(query, user);
  }

  @Get('summary')
  @RequirePermissions('product_quality:view')
  @ApiOperation({ summary: 'Tổng hợp số liệu & đếm theo trạng thái/bộ phận' })
  getSummary(@Query() query: ProductQualityQueryDto, @CurrentUser() user: any) {
    return this.service.getSummary(query, user);
  }

  @Get('export')
  @RequirePermissions('product_quality:export')
  @ApiOperation({ summary: 'Xuất file Excel tổng quan các phiếu sự cố' })
  async export(
    @Query() query: ProductQualityQueryDto,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=ChatLuongSanPham_${ts}.xlsx`,
    );

    await this.service.exportTickets(query, user, res);
  }

  @Get('export-detail')
  @RequirePermissions('product_quality:export')
  @ApiOperation({ summary: 'Xuất file Excel chi tiết nhiệm vụ từng bộ phận' })
  async exportDetail(
    @Query() query: ProductQualityQueryDto,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=ChatLuongSanPham_ChiTiet_${ts}.xlsx`,
    );

    await this.service.exportTicketsDetail(query, user, res);
  }

  @Get('routing-configs')
  @RequirePermissions('product_quality:configure')
  @ApiOperation({ summary: 'Danh sách cấu hình routing người quyết định' })
  getRoutingConfigs() {
    return this.service.getRoutingConfigs();
  }

  @Post('routing-configs')
  @RequirePermissions('product_quality:configure')
  @ApiOperation({ summary: 'Cập nhật cấu hình routing người quyết định' })
  upsertRoutingConfig(@Body() dto: UpsertRoutingConfigDto) {
    return this.service.upsertRoutingConfig(dto);
  }

  @Get('department-members')
  @RequirePermissions('product_quality:configure')
  @ApiOperation({ summary: 'Danh sách thành viên bộ phận' })
  getDepartmentMembers(@Query('branchId') branchId?: string) {
    return this.service.getDepartmentMembers(branchId ? +branchId : undefined);
  }

  @Post('department-members')
  @RequirePermissions('product_quality:configure')
  @ApiOperation({ summary: 'Thêm/sửa thành viên bộ phận' })
  upsertDepartmentMember(@Body() dto: UpsertDepartmentMemberDto) {
    return this.service.upsertDepartmentMember(dto);
  }

  @Delete('department-members/:id')
  @RequirePermissions('product_quality:configure')
  @ApiOperation({ summary: 'Xóa thành viên bộ phận' })
  deleteDepartmentMember(@Param('id') id: string) {
    return this.service.deleteDepartmentMember(+id);
  }

  @Post('import/lark')
  @RequirePermissions('product_quality:import')
  @ApiOperation({ summary: 'Import dữ liệu từ LarkBase (preview hoặc commit)' })
  importFromLark(@Body() dto: LarkImportDto, @CurrentUser() user: any) {
    return this.service.importFromLark(dto, user.id);
  }

  @Get('import/template')
  @RequirePermissions('product_quality:view')
  @ApiOperation({ summary: 'Tải file Excel mẫu import sự cố chất lượng' })
  async downloadTemplate(@Res() res: Response) {
    const buffer = await this.service.getImportTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=ChatLuongHangHoa_MauImport.xlsx',
    );
    res.send(buffer);
  }

  @Post('import/preview')
  @RequirePermissions('product_quality:import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Xem trước file Excel import sự cố chất lượng (không ghi DB)' })
  previewImport(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
    @Headers('x-branch-id') branchHeader?: string,
  ) {
    const branchId = branchHeader ? parseInt(branchHeader, 10) : undefined;
    return this.service.previewExcelImport(file, user, branchId);
  }

  @Post('import')
  @RequirePermissions('product_quality:import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Import dữ liệu sự cố chất lượng từ file Excel vào DB' })
  commitImport(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
    @Headers('x-branch-id') branchHeader?: string,
  ) {
    const branchId = branchHeader ? parseInt(branchHeader, 10) : undefined;
    return this.service.commitExcelImport(file, user, branchId);
  }

  @Get(':id')
  @RequirePermissions('product_quality:view')
  @ApiOperation({ summary: 'Chi tiết phiếu sự cố chất lượng' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOne(+id, user);
  }

  @Post()
  @RequirePermissions('product_quality:create')
  @ApiOperation({ summary: 'Tạo phiếu sự cố chất lượng' })
  create(
    @Body() dto: CreateProductQualityTicketDto,
    @CurrentUser() user: any,
    @Headers('x-branch-id') branchHeader?: string,
  ) {
    const branchId = branchHeader ? parseInt(branchHeader, 10) : undefined;
    return this.service.create(dto, user.id, branchId);
  }

  @Put(':id')
  @RequirePermissions('product_quality:update')
  @ApiOperation({ summary: 'Cập nhật thông tin phiếu' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductQualityTicketDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(+id, dto, user.id);
  }

  @Post(':id/assign')
  @RequirePermissions('product_quality:assign')
  @ApiOperation({ summary: 'Cập nhật hướng xử lý & giao nhiệm vụ bộ phận' })
  assign(
    @Param('id') id: string,
    @Body() dto: AssignProductQualityTicketDto,
    @CurrentUser() user: any,
  ) {
    return this.service.assign(+id, dto, user.id);
  }

  @Post(':id/tasks/:department')
  @RequirePermissions('product_quality:complete')
  @ApiOperation({ summary: 'Cập nhật phản hồi / hoàn tất nhiệm vụ của bộ phận' })
  updateTask(
    @Param('id') id: string,
    @Param('department') department: string,
    @Body() dto: UpdateProductQualityTaskDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateTask(+id, department, dto, user.id);
  }

  @Post(':id/close')
  @RequirePermissions('product_quality:close')
  @ApiOperation({ summary: 'Kết thúc phiếu thủ công (ENDED)' })
  close(
    @Param('id') id: string,
    @Body() dto: CloseProductQualityTicketDto,
    @CurrentUser() user: any,
  ) {
    return this.service.close(+id, dto, user.id);
  }

  @Delete(':id')
  @RequirePermissions('product_quality:delete')
  @ApiOperation({ summary: 'Xóa phiếu mới' })
  delete(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.delete(+id, user.id);
  }
}
