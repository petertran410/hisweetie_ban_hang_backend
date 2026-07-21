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

  @Get('internal-use/export')
  @RequirePermissions('internal-use:export')
  async export(@Query() query: InternalUseQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=XuatDungNoiBo_${ts}.xlsx`,
    );

    await this.internalUseService.exportInternalUses(query, res);
  }

  @Get('internal-use/export-detail')
  @RequirePermissions('internal-use:export')
  async exportDetail(
    @Query() query: InternalUseQueryDto,
    @Res() res: Response,
  ) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=XuatDungNoiBo_ChiTiet_${ts}.xlsx`,
    );

    await this.internalUseService.exportInternalUsesDetail(query, res);
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
    const user = {
      permissions: req.user?.permissions || [],
      roles: req.user?.roles || [],
    };
    return this.internalUseService.create(dto, userId, user);
  }

  @Put('internal-use/:id')
  @RequirePermissions('internal-use:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInternalUseDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    const user = {
      permissions: req.user?.permissions || [],
      roles: req.user?.roles || [],
    };
    return this.internalUseService.update(+id, dto, userId, user);
  }

  @Post('internal-use/:id/complete')
  @RequirePermissions('internal-use:complete')
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
