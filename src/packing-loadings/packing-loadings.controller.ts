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
import { PackingLoadingsService } from './packing-loadings.service';
import {
  CreatePackingLoadingDto,
  UpdatePackingLoadingDto,
  PackingLoadingQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Packing Loadings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('packing-loadings')
export class PackingLoadingsController {
  constructor(private packingLoadingsService: PackingLoadingsService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách loading' })
  findAll(@Query() query: PackingLoadingQueryDto) {
    return this.packingLoadingsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết loading theo ID' })
  findOne(@Param('id') id: string) {
    return this.packingLoadingsService.findOne(+id);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo mới loading' })
  create(@Body() dto: CreatePackingLoadingDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingLoadingsService.create(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Cập nhật loading' })
  update(@Param('id') id: string, @Body() dto: UpdatePackingLoadingDto) {
    return this.packingLoadingsService.update(+id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa loading' })
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingLoadingsService.remove(+id, userId);
  }
}
