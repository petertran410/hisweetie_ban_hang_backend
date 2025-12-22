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

@ApiTags('Customer Groups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('customer-groups')
export class CustomerGroupsController {
  constructor(private customerGroupsService: CustomerGroupsService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách nhóm khách hàng' })
  findAll() {
    return this.customerGroupsService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết nhóm khách hàng' })
  findOne(@Param('id') id: string) {
    return this.customerGroupsService.findOne(+id);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo mới nhóm khách hàng' })
  create(@Body() dto: CreateCustomerGroupDto, @Req() req: any) {
    const userId = req.user?.id;
    return this.customerGroupsService.create(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Cập nhật nhóm khách hàng' })
  update(@Param('id') id: string, @Body() dto: UpdateCustomerGroupDto) {
    return this.customerGroupsService.update(+id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa nhóm khách hàng' })
  remove(@Param('id') id: string) {
    return this.customerGroupsService.remove(+id);
  }

  @Post(':id/add-customers')
  @ApiOperation({ summary: 'Thêm khách hàng vào nhóm' })
  addCustomers(@Param('id') id: string, @Body() dto: ManageCustomersDto) {
    return this.customerGroupsService.addCustomersToGroup(+id, dto.customerIds);
  }

  @Post(':id/remove-customers')
  @ApiOperation({ summary: 'Xóa khách hàng khỏi nhóm' })
  removeCustomers(@Param('id') id: string, @Body() dto: ManageCustomersDto) {
    return this.customerGroupsService.removeCustomersFromGroup(
      +id,
      dto.customerIds,
    );
  }
}
