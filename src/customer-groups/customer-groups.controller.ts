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
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

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

  @Get(':id')
  @RequirePermissions('customer_groups:view')
  @ApiOperation({ summary: 'Lấy chi tiết nhóm khách hàng' })
  findOne(@Param('id') id: string) {
    return this.customerGroupsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('customer_groups:create')
  @ApiOperation({ summary: 'Tạo mới nhóm khách hàng' })
  create(@Body() dto: CreateCustomerGroupDto, @Req() req: any) {
    const userId = req.user?.id;
    return this.customerGroupsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('customer_groups:update')
  @ApiOperation({ summary: 'Cập nhật nhóm khách hàng' })
  update(@Param('id') id: string, @Body() dto: UpdateCustomerGroupDto) {
    return this.customerGroupsService.update(+id, dto);
  }

  @Delete(':id')
  @RequirePermissions('customer_groups:delete')
  @ApiOperation({ summary: 'Xóa nhóm khách hàng' })
  remove(@Param('id') id: string) {
    return this.customerGroupsService.remove(+id);
  }

  @Post(':id/add-customers')
  @RequirePermissions('customer_groups:update')
  @ApiOperation({ summary: 'Thêm khách hàng vào nhóm' })
  addCustomers(@Param('id') id: string, @Body() dto: ManageCustomersDto) {
    return this.customerGroupsService.addCustomersToGroup(+id, dto.customerIds);
  }

  @Post(':id/remove-customers')
  @RequirePermissions('customer_groups:update')
  @ApiOperation({ summary: 'Xóa khách hàng khỏi nhóm' })
  removeCustomers(@Param('id') id: string, @Body() dto: ManageCustomersDto) {
    return this.customerGroupsService.removeCustomersFromGroup(
      +id,
      dto.customerIds,
    );
  }
}
