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
  Res,
} from '@nestjs/common';
import { Response } from 'express';
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

  @Get('export')
  @RequirePermissions('destructions:export')
  async export(@Query() query: DestructionQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=XuatHuy_${ts}.xlsx`,
    );

    await this.destructionsService.exportDestructions(query, res);
  }

  @Get('export-detail')
  @RequirePermissions('destructions:export')
  async exportDetail(@Query() query: DestructionQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=XuatHuy_ChiTiet_${ts}.xlsx`,
    );

    await this.destructionsService.exportDestructionsDetail(query, res);
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
