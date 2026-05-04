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
  Req,
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  CustomerQueryDto,
  BulkCreateCustomerDto,
  BulkUpdateCustomerDto,
  ImportCustomersDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('customers')
export class CustomersController {
  constructor(private customersService: CustomersService) {}

  @Get()
  @RequirePermissions('customers:view')
  @ApiOperation({ summary: 'Lấy danh sách khách hàng' })
  findAll(@Query() query: CustomerQueryDto, @Req() req: any) {
    return this.customersService.findAll(query, req.user.id);
  }

  @Get('search')
  @RequirePermissions('customers:view')
  @ApiOperation({ summary: 'Tìm kiếm khách hàng (dùng cho dropdown POS)' })
  search(@Query('search') search?: string) {
    return this.customersService.searchCustomers(search);
  }

  @Get('code/:code')
  @RequirePermissions('customers:view')
  @ApiOperation({ summary: 'Lấy chi tiết khách hàng theo Code' })
  findByCode(@Param('code') code: string) {
    return this.customersService.findByCode(code);
  }

  @Get(':id')
  @RequirePermissions('customers:view')
  @ApiOperation({ summary: 'Lấy chi tiết khách hàng theo ID' })
  findOne(@Param('id') id: string) {
    return this.customersService.findOne(+id);
  }

  @Get(':id/debt-timeline')
  @RequirePermissions('customers:view')
  @ApiOperation({ summary: 'Get customer debt timeline' })
  getDebtTimeline(
    @Param('id') id: string,
    @Query('includeChildren') includeChildren?: string,
  ) {
    return this.customersService.getDebtTimeline(
      +id,
      includeChildren === 'true',
    );
  }

  @Post()
  @RequirePermissions('customers:create')
  @ApiOperation({ summary: 'Thêm mới khách hàng' })
  create(@Body() dto: CreateCustomerDto, @Req() req: any) {
    const userId = req.user?.id;
    return this.customersService.create(dto, userId);
  }

  @Post('listaddcutomers')
  @RequirePermissions('customers:create')
  @ApiOperation({ summary: 'Thêm mới danh sách khách hàng' })
  bulkCreate(@Body() dto: BulkCreateCustomerDto) {
    return this.customersService.bulkCreate(dto);
  }

  @Post('import')
  @RequirePermissions('customers:create')
  @ApiOperation({ summary: 'Import khách hàng từ file Excel' })
  importCustomers(@Body() dto: ImportCustomersDto, @Req() req: any) {
    const userId = req.user?.id;
    return this.customersService.importCustomers(dto, userId);
  }

  @Put('listupdatecustomers')
  @RequirePermissions('customers:update')
  @ApiOperation({ summary: 'Cập nhật danh sách khách hàng' })
  bulkUpdate(@Body() dto: BulkUpdateCustomerDto) {
    return this.customersService.bulkUpdate(dto);
  }

  @Put(':id')
  @RequirePermissions('customers:update')
  @ApiOperation({ summary: 'Cập nhật khách hàng' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    return this.customersService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('customers:delete')
  @ApiOperation({ summary: 'Xóa khách hàng' })
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    return this.customersService.remove(+id, userId);
  }
}
