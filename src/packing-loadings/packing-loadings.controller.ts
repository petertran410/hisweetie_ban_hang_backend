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
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('Packing Loadings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('packing-loadings')
export class PackingLoadingsController {
  constructor(private packingLoadingsService: PackingLoadingsService) {}

  @Get()
  @RequirePermissions('packing_loadings:view')
  findAll(@Query() query: PackingLoadingQueryDto) {
    return this.packingLoadingsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('packing_loadings:view')
  findOne(@Param('id') id: string) {
    return this.packingLoadingsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('packing_loadings:create')
  create(@Body() dto: CreatePackingLoadingDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingLoadingsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('packing_loadings:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePackingLoadingDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.packingLoadingsService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('packing_loadings:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.packingLoadingsService.remove(+id, userId);
  }

  @Post(':id/resend-lark')
  @RequirePermissions('packing_loadings:update')
  resendLark(@Param('id') id: string) {
    return this.packingLoadingsService.resendLarkNotification(+id);
  }
}
