import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Put,
} from '@nestjs/common';
import { InventoryChecksService } from './inventory-checks.service';
import { CreateInventoryCheckDto, InventoryCheckQueryDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Inventory Checks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('inventory-checks')
export class InventoryChecksController {
  constructor(private service: InventoryChecksService) {}

  @Get()
  @RequirePermissions('inventory_checks:view')
  findAll(@Query() query: InventoryCheckQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('inventory_checks:view')
  findOne(@Param('id') id: string) {
    return this.service.findOne(+id);
  }

  @Post()
  @RequirePermissions('inventory_checks:create')
  create(@Body() dto: CreateInventoryCheckDto, @CurrentUser() user: any) {
    return this.service.create(dto, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('inventory_checks:update')
  cancel(@Param('id') id: string) {
    return this.service.cancel(+id);
  }
}
