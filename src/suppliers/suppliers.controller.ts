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
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto, UpdateSupplierDto, SupplierQueryDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Suppliers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('suppliers')
export class SuppliersController {
  constructor(private suppliersService: SuppliersService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách nhà cung cấp' })
  findAll(@Query() query: SupplierQueryDto) {
    return this.suppliersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết nhà cung cấp theo ID' })
  findOne(@Param('id') id: string) {
    return this.suppliersService.findOne(+id);
  }

  @Get('code/:code')
  @ApiOperation({ summary: 'Lấy chi tiết nhà cung cấp theo Code' })
  findByCode(@Param('code') code: string) {
    return this.suppliersService.findByCode(code);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo mới nhà cung cấp' })
  create(@Body() dto: CreateSupplierDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.suppliersService.create(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Cập nhật nhà cung cấp' })
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliersService.update(+id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa nhà cung cấp' })
  remove(@Param('id') id: string) {
    return this.suppliersService.remove(+id);
  }
}
