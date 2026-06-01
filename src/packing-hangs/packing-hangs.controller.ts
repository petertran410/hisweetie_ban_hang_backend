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
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('Packing Hangs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('packing-hangs')
export class PackingHangsController {
  constructor(private packingHangsService: PackingHangsService) {}

  @Get()
  @RequirePermissions('packing_hangs:view')
  findAll(@Query() query: PackingHangQueryDto) {
    return this.packingHangsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('packing_hangs:view')
  findOne(@Param('id') id: string) {
    return this.packingHangsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('packing_hangs:create')
  create(@Body() dto: CreatePackingHangDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingHangsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('packing_hangs:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePackingHangDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.packingHangsService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('packing_hangs:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingHangsService.remove(+id, userId);
  }
}
