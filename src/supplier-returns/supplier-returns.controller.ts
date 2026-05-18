import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { SupplierReturnsService } from './supplier-returns.service';
import {
  CreateSupplierReturnDto,
  ConfirmExportDto,
  ConfirmRefundDto,
  SupplierReturnQueryDto,
  UpdateStep1Dto,
  ImportSupplierReturnsDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Supplier Returns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('supplier-returns')
export class SupplierReturnsController {
  constructor(private supplierReturnsService: SupplierReturnsService) {}

  @Get()
  @RequirePermissions('supplier_returns:view')
  findAll(@Query() query: SupplierReturnQueryDto) {
    return this.supplierReturnsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('supplier_returns:view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.supplierReturnsService.findOne(id);
  }

  @Post()
  @RequirePermissions('supplier_returns:create')
  create(@Body() dto: CreateSupplierReturnDto, @CurrentUser() user: any) {
    return this.supplierReturnsService.create(dto, user.id);
  }

  @Put(':id/update-step1')
  @RequirePermissions('supplier_returns:update')
  updateStep1(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStep1Dto,
    @CurrentUser() user: any,
  ) {
    return this.supplierReturnsService.updateStep1(id, dto, user.id);
  }

  @Put(':id/confirm-export')
  @RequirePermissions('supplier_returns:confirm_export')
  confirmExport(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmExportDto,
    @CurrentUser() user: any,
  ) {
    return this.supplierReturnsService.confirmExport(id, dto, user.id);
  }

  @Put(':id/confirm-refund')
  @RequirePermissions('supplier_returns:confirm_refund')
  confirmRefund(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmRefundDto,
    @CurrentUser() user: any,
  ) {
    return this.supplierReturnsService.confirmRefund(id, dto, user.id);
  }

  @Post('import')
  @RequirePermissions('supplier_returns:create')
  importFromExcel(
    @Body() dto: ImportSupplierReturnsDto,
    @CurrentUser() user: any,
  ) {
    return this.supplierReturnsService.importFromExcel(dto, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('supplier_returns:update')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.supplierReturnsService.cancel(id, user.id);
  }
}
