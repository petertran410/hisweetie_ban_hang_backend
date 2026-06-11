import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { BorderGatesService } from './border-gates.service';

@ApiTags('Border Gates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('border-gates')
export class BorderGatesController {
  constructor(private borderGatesService: BorderGatesService) {}

  @Get()
  @RequirePermissions('vehicle_shipments:view')
  findAll(@Query('includeInactive') includeInactive?: string) {
    return this.borderGatesService.findAll(includeInactive === 'true');
  }

  @Get(':id')
  @RequirePermissions('vehicle_shipments:view')
  findOne(@Param('id') id: string) {
    return this.borderGatesService.findOne(+id);
  }

  @Post()
  @RequirePermissions('vehicle_shipments:create')
  create(
    @Body() dto: { name: string; description?: string; isActive?: boolean },
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.borderGatesService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('vehicle_shipments:update')
  update(
    @Param('id') id: string,
    @Body() dto: { name?: string; description?: string; isActive?: boolean },
  ) {
    return this.borderGatesService.update(+id, dto);
  }

  @Delete(':id')
  @RequirePermissions('vehicle_shipments:update')
  remove(@Param('id') id: string) {
    return this.borderGatesService.remove(+id);
  }
}
