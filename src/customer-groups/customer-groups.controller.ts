import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { CustomerGroupsService } from './customer-groups.service';
import {
  CreateCustomerGroupDto,
  UpdateCustomerGroupDto,
  ManageCustomersDto,
  CancelCustomerGroupDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

type AuthReq = { user?: { id?: number } };

@ApiTags('Customer Groups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('customer-groups')
export class CustomerGroupsController {
  constructor(private customerGroupsService: CustomerGroupsService) {}

  @Get()
  @RequirePermissions('customer_groups:view')
  @ApiOperation({ summary: 'Lấy danh sách nhóm khách hàng' })
  findAll() {
    return this.customerGroupsService.findAll();
  }

  // Khai báo trước ':id' để không bị bắt nhầm thành id = "cancelled"
  @Get('cancelled')
  @RequirePermissions('customer_groups:view')
  @ApiOperation({ summary: 'Danh sách nhóm khách hàng đã hủy' })
  findCancelled() {
    return this.customerGroupsService.findCancelled();
  }

  @Get(':id')
  @RequirePermissions('customer_groups:view')
  @ApiOperation({ summary: 'Lấy chi tiết nhóm khách hàng' })
  findOne(@Param('id') id: string) {
    return this.customerGroupsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('customer_groups:create')
  @ApiOperation({ summary: 'Tạo mới nhóm khách hàng' })
  create(@Body() dto: CreateCustomerGroupDto, @Req() req: AuthReq) {
    const userId = req.user?.id;
    return this.customerGroupsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('customer_groups:update')
  @ApiOperation({ summary: 'Cập nhật nhóm khách hàng' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerGroupDto,
    @Req() req: AuthReq,
  ) {
    return this.customerGroupsService.update(+id, dto, req.user?.id);
  }

  // Không xóa hẳn: DELETE giờ chỉ hủy nhóm (nhóm còn khách sẽ bị từ chối).
  @Delete(':id')
  @RequirePermissions('customer_groups:delete')
  @ApiOperation({ summary: 'Hủy nhóm khách hàng (không xóa dữ liệu)' })
  remove(@Param('id') id: string, @Req() req: AuthReq) {
    return this.customerGroupsService.cancel(+id, req.user?.id, false);
  }

  @Post(':id/cancel')
  @RequirePermissions('customer_groups:delete')
  @ApiOperation({ summary: 'Hủy nhóm khách hàng, có thể gỡ hết khách' })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelCustomerGroupDto,
    @Req() req: AuthReq,
  ) {
    return this.customerGroupsService.cancel(
      +id,
      req.user?.id,
      dto.removeCustomers === true,
    );
  }

  @Post(':id/restore')
  @RequirePermissions('customer_groups:update')
  @ApiOperation({ summary: 'Khôi phục nhóm khách hàng đã hủy' })
  restore(@Param('id') id: string, @Req() req: AuthReq) {
    return this.customerGroupsService.restore(+id, req.user?.id);
  }

  @Post(':id/add-customers')
  @RequirePermissions('customer_groups:update')
  @ApiOperation({ summary: 'Thêm khách hàng vào nhóm' })
  addCustomers(
    @Param('id') id: string,
    @Body() dto: ManageCustomersDto,
    @Req() req: AuthReq,
  ) {
    return this.customerGroupsService.addCustomersToGroup(
      +id,
      dto.customerIds,
      req.user?.id,
    );
  }

  @Post(':id/remove-customers')
  @RequirePermissions('customer_groups:update')
  @ApiOperation({ summary: 'Xóa khách hàng khỏi nhóm' })
  removeCustomers(
    @Param('id') id: string,
    @Body() dto: ManageCustomersDto,
    @Req() req: AuthReq,
  ) {
    return this.customerGroupsService.removeCustomersFromGroup(
      +id,
      dto.customerIds,
      req.user?.id,
    );
  }
}
