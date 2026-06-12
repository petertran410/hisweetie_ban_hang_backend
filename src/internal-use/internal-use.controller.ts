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
import { InternalUseService } from './internal-use.service';
import {
  CreateInternalUseDto,
  UpdateInternalUseDto,
  InternalUseQueryDto,
  CancelInternalUseDto,
  CreatePurposeDto,
  UpdatePurposeDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('InternalUse')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class InternalUseController {
  constructor(private internalUseService: InternalUseService) {}

  @Get('internal-use-purposes')
  @RequirePermissions('internal-use:view')
  findAllPurposes() {
    return this.internalUseService.findAllPurposes();
  }

  @Post('internal-use-purposes')
  @RequirePermissions('internal-use-purpose:manage')
  createPurpose(@Body() dto: CreatePurposeDto) {
    return this.internalUseService.createPurpose(dto);
  }

  @Put('internal-use-purposes/:id')
  @RequirePermissions('internal-use-purpose:manage')
  updatePurpose(@Param('id') id: string, @Body() dto: UpdatePurposeDto) {
    return this.internalUseService.updatePurpose(+id, dto);
  }

  @Delete('internal-use-purposes/:id')
  @RequirePermissions('internal-use-purpose:manage')
  deletePurpose(@Param('id') id: string) {
    return this.internalUseService.deletePurpose(+id);
  }

  @Get('internal-use')
  @RequirePermissions('internal-use:view')
  findAll(@Query() query: InternalUseQueryDto) {
    return this.internalUseService.findAll(query);
  }

  @Get('internal-use/:id')
  @RequirePermissions('internal-use:view')
  findOne(@Param('id') id: string) {
    return this.internalUseService.findOne(+id);
  }

  @Post('internal-use')
  @RequirePermissions('internal-use:create')
  create(@Body() dto: CreateInternalUseDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.internalUseService.create(dto, userId);
  }

  @Put('internal-use/:id')
  @RequirePermissions('internal-use:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInternalUseDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.internalUseService.update(+id, dto, userId);
  }

  @Post('internal-use/:id/complete')
  @RequirePermissions('internal-use:update')
  complete(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.internalUseService.complete(+id, userId);
  }

  @Put('internal-use/:id/cancel')
  @RequirePermissions('internal-use:update')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelInternalUseDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.internalUseService.cancel(+id, dto, userId);
  }
}
