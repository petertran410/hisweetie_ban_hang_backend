import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { CreatePermissionDto, UpdatePermissionDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Permissions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('permissions')
export class PermissionsController {
  constructor(private permissionsService: PermissionsService) {}

  @Get()
  @RequirePermissions('permissions.view')
  @ApiOperation({ summary: 'Get all permissions' })
  findAll() {
    return this.permissionsService.findAll();
  }

  @Get('grouped')
  @RequirePermissions('permissions.view')
  @ApiOperation({ summary: 'Get permissions grouped by resource' })
  getGrouped() {
    return this.permissionsService.getGroupedByResource();
  }

  @Get(':id')
  @RequirePermissions('permissions.view')
  @ApiOperation({ summary: 'Get permission by ID' })
  findOne(@Param('id') id: string) {
    return this.permissionsService.findOne(+id);
  }

  @Get('resource/:resource')
  @RequirePermissions('permissions.view')
  @ApiOperation({ summary: 'Get permissions by resource' })
  findByResource(@Param('resource') resource: string) {
    return this.permissionsService.findByResource(resource);
  }

  @Post()
  @RequirePermissions('permissions.create')
  @ApiOperation({ summary: 'Create new permission' })
  create(@Body() dto: CreatePermissionDto) {
    return this.permissionsService.create(dto);
  }

  @Put(':id')
  @RequirePermissions('permissions.update')
  @ApiOperation({ summary: 'Update permission' })
  update(@Param('id') id: string, @Body() dto: UpdatePermissionDto) {
    return this.permissionsService.update(+id, dto);
  }

  @Delete(':id')
  @RequirePermissions('permissions.delete')
  @ApiOperation({ summary: 'Delete permission' })
  remove(@Param('id') id: string) {
    return this.permissionsService.remove(+id);
  }
}
