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
import { PackingHangsService } from './packing-hangs.service';
import {
  CreatePackingHangDto,
  UpdatePackingHangDto,
  PackingHangQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Packing Hangs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('packing-hangs')
export class PackingHangsController {
  constructor(private packingHangsService: PackingHangsService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách đóng hàng' })
  findAll(@Query() query: PackingHangQueryDto) {
    return this.packingHangsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết đóng hàng theo ID' })
  findOne(@Param('id') id: string) {
    return this.packingHangsService.findOne(+id);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo mới đóng hàng' })
  create(@Body() dto: CreatePackingHangDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingHangsService.create(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Cập nhật đóng hàng' })
  update(@Param('id') id: string, @Body() dto: UpdatePackingHangDto) {
    return this.packingHangsService.update(+id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa đóng hàng' })
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingHangsService.remove(+id, userId);
  }
}
