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
import { PackingSlipsService } from './packing-slips.service';
import {
  CreatePackingSlipDto,
  UpdatePackingSlipDto,
  PackingSlipQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('Packing Slips')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('packing-slips')
export class PackingSlipsController {
  constructor(private packingSlipsService: PackingSlipsService) {}

  @Get()
  @RequirePermissions('packing_slips:view')
  findAll(@Query() query: PackingSlipQueryDto) {
    return this.packingSlipsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('packing_slips:view')
  findOne(@Param('id') id: string) {
    return this.packingSlipsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('packing_slips:create')
  create(@Body() dto: CreatePackingSlipDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingSlipsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('packing_slips:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePackingSlipDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.packingSlipsService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('packing_slips:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingSlipsService.remove(+id, userId);
  }
}
