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
import { DestructionsService } from './destructions.service';
import {
  CreateDestructionDto,
  UpdateDestructionDto,
  DestructionQueryDto,
  CancelDestructionDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('Destructions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('destructions')
export class DestructionsController {
  constructor(private destructionsService: DestructionsService) {}

  @Get()
  @RequirePermissions('destructions:view')
  findAll(@Query() query: DestructionQueryDto) {
    return this.destructionsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('destructions:view')
  findOne(@Param('id') id: string) {
    return this.destructionsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('destructions:create')
  create(@Body() dto: CreateDestructionDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.destructionsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('destructions:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDestructionDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.destructionsService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('destructions:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.destructionsService.remove(+id, userId);
  }

  @Put(':id/cancel')
  @RequirePermissions('destructions:update')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelDestructionDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.destructionsService.cancelDestruction(+id, dto, userId);
  }
}
