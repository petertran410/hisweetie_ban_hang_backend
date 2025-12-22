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
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  CustomerQueryDto,
  BulkCreateCustomerDto,
  BulkUpdateCustomerDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('customers')
export class CustomersController {
  constructor(private customersService: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách khách hàng' })
  findAll(@Query() query: CustomerQueryDto) {
    return this.customersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết khách hàng theo ID' })
  findOne(@Param('id') id: string) {
    return this.customersService.findOne(+id);
  }

  @Get('code/:code')
  @ApiOperation({ summary: 'Lấy chi tiết khách hàng theo Code' })
  findByCode(@Param('code') code: string) {
    return this.customersService.findByCode(code);
  }

  @Post()
  @ApiOperation({ summary: 'Thêm mới khách hàng' })
  create(@Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Cập nhật khách hàng' })
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customersService.update(+id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa khách hàng' })
  remove(@Param('id') id: string) {
    return this.customersService.remove(+id);
  }

  @Post('listaddcutomers')
  @ApiOperation({ summary: 'Thêm mới danh sách khách hàng' })
  bulkCreate(@Body() dto: BulkCreateCustomerDto) {
    return this.customersService.bulkCreate(dto);
  }

  @Put('listupdatecustomers')
  @ApiOperation({ summary: 'Cập nhật danh sách khách hàng' })
  bulkUpdate(@Body() dto: BulkUpdateCustomerDto) {
    return this.customersService.bulkUpdate(dto);
  }
}
