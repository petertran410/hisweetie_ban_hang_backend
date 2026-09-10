import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  CreateCustomerDemandDto,
  CustomerDemandMonthActionDto,
  CustomerDemandQueryDto,
  UpdateCustomerDemandDto,
} from '../dto';
import { CustomerDemandImportService } from '../services/customer-demand-import.service';
import { CustomerDemandService } from '../services/customer-demand.service';

@ApiTags('Customer Demand')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('customer-demand')
export class CustomerDemandController {
  constructor(
    private readonly service: CustomerDemandService,
    private readonly importService: CustomerDemandImportService,
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
    if (!allowed.includes(file.mimetype) && !file.originalname.toLowerCase().endsWith('.xlsx')) {
      throw new BadRequestException('Chỉ chấp nhận file Excel (.xlsx)');
    }
  }

  @Get()
  @RequirePermissions('customer_demand:view')
  list(@Query() query: CustomerDemandQueryDto) {
    return this.service.list(query);
  }

  @Get('customers/search')
  @RequirePermissions('customer_demand:view')
  searchCustomers(@Query('search') search?: string) {
    return this.service.searchCustomers(search);
  }

  @Get('import/template')
  @RequirePermissions('customer_demand:view')
  async downloadImportTemplate(@Res() res: Response) {
    const buffer = await this.importService.template();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=mau-import-demand-khach-hang.xlsx',
    );
    res.send(buffer);
  }

  @Post('import/preview')
  @RequirePermissions('customer_demand:create')
  @UseInterceptors(
    FileInterceptor('file', CustomerDemandController.UPLOAD_OPTIONS),
  )
  previewImport(@UploadedFile() file: Express.Multer.File) {
    this.assertExcel(file);
    return this.importService.preview(file);
  }

  @Post('import')
  @RequirePermissions('customer_demand:create')
  @UseInterceptors(
    FileInterceptor('file', CustomerDemandController.UPLOAD_OPTIONS),
  )
  commitImport(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: { id: number },
  ) {
    this.assertExcel(file);
    return this.importService.commit(file, user.id);
  }

  @Get(':id')
  @RequirePermissions('customer_demand:view')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermissions('customer_demand:create')
  create(
    @Body() dto: CreateCustomerDemandDto,
    @CurrentUser() user: { id: number },
  ) {
    return this.service.create(dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('customer_demand:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCustomerDemandDto,
    @CurrentUser() user: { id: number },
  ) {
    return this.service.update(id, dto, user.id);
  }

  @Post('months/:id/approve')
  @RequirePermissions('customer_demand:approve')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: { id: number },
  ) {
    return this.service.approveMonth(id, user.id);
  }

  @Post('months/:id/cancel')
  @RequirePermissions('customer_demand:cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CustomerDemandMonthActionDto,
    @CurrentUser() user: { id: number },
  ) {
    return this.service.cancelMonth(id, dto, user.id);
  }
}
