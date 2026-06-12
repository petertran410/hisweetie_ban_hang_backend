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
import { FactoriesService } from './factories.service';

@ApiTags('Factories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('factories')
export class FactoriesController {
  constructor(private factoriesService: FactoriesService) {}

  @Get()
  @RequirePermissions('order_suppliers:view')
  findAll(@Query('includeInactive') includeInactive?: string) {
    return this.factoriesService.findAll(includeInactive === 'true');
  }

  @Get(':id')
  @RequirePermissions('order_suppliers:view')
  findOne(@Param('id') id: string) {
    return this.factoriesService.findOne(+id);
  }

  @Post()
  @RequirePermissions('order_suppliers:update')
  create(
    @Body() dto: { name: string; description?: string; isActive?: boolean },
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.factoriesService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('order_suppliers:update')
  update(
    @Param('id') id: string,
    @Body() dto: { name?: string; description?: string; isActive?: boolean },
  ) {
    return this.factoriesService.update(+id, dto);
  }

  @Delete(':id')
  @RequirePermissions('order_suppliers:update')
  remove(@Param('id') id: string) {
    return this.factoriesService.remove(+id);
  }
}
