import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { VehicleShipmentsService } from './vehicle-shipments.service';
import {
  CreateVehicleShipmentDto,
  UpdateVehicleShipmentDto,
  VehicleShipmentQueryDto,
  CreatePurchaseOrdersFromVehicleDto,
  ResolveVehicleItemDto,
} from './dto';
import { getSupplierScope } from '../auth/supplier-scope.util';

/** Chặn tài khoản nhân viên nhà cung cấp thao tác ghi (ghép xe là việc nội bộ). */
function assertNotSupplierStaff(req: any) {
  if (getSupplierScope(req) != null) {
    throw new ForbiddenException(
      'Tài khoản nhà cung cấp không có quyền thao tác này',
    );
  }
}

@ApiTags('Vehicle Shipments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('vehicle-shipments')
export class VehicleShipmentsController {
  constructor(private vehicleShipmentsService: VehicleShipmentsService) {}

  @Get()
  @RequirePermissions('vehicle_shipments:view')
  findAll(@Query() query: VehicleShipmentQueryDto, @Req() req: any) {
    return this.vehicleShipmentsService.findAll(query, getSupplierScope(req));
  }

  @Get('available-items')
  @RequirePermissions('vehicle_shipments:view')
  @ApiOperation({
    summary: 'Danh sách PDN + SP còn có thể ghép xe (Đặt − Nhập − Ghép > 0)',
  })
  getAvailableItems(@Req() req: any, @Query('branchId') branchId?: string) {
    return this.vehicleShipmentsService.getAvailableItems(
      branchId ? +branchId : undefined,
      getSupplierScope(req),
    );
  }

  @Get(':id')
  @RequirePermissions('vehicle_shipments:view')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.vehicleShipmentsService.findOne(+id, getSupplierScope(req));
  }

  @Post()
  @RequirePermissions('vehicle_shipments:create')
  create(@Body() dto: CreateVehicleShipmentDto, @Req() req: any) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.vehicleShipmentsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('vehicle_shipments:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateVehicleShipmentDto,
    @Req() req: any,
  ) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.vehicleShipmentsService.update(+id, dto, userId);
  }

  @Put(':id/cancel')
  @RequirePermissions('vehicle_shipments:update')
  @ApiOperation({ summary: 'Hủy mềm phiếu ghép xe' })
  cancel(@Param('id') id: string, @Req() req: any) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.vehicleShipmentsService.cancel(+id, userId);
  }

  @Post(':id/create-purchase-orders')
  @RequirePermissions('purchase_orders:create')
  @ApiOperation({
    summary: 'Sinh N phiếu nhập từ phiếu ghép xe (mỗi PDN một phiếu)',
  })
  createPurchaseOrders(
    @Param('id') id: string,
    @Body() dto: CreatePurchaseOrdersFromVehicleDto,
    @Req() req: any,
  ) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.vehicleShipmentsService.createPurchaseOrders(+id, dto, userId);
  }

  @Put(':id/resolve-item')
  @RequirePermissions('vehicle_shipments:update')
  @ApiOperation({
    summary: 'Xử lý chênh lệch sau nhập cho 1 sản phẩm (chuyển về còn lại/giữ)',
  })
  resolveItem(
    @Param('id') id: string,
    @Body() dto: ResolveVehicleItemDto,
    @Req() req: any,
  ) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.vehicleShipmentsService.resolveItem(+id, dto, userId);
  }
}
