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
import { requestHasPermission } from '../auth/request-permissions';

// Khớp useCanViewInternalUseCost phía frontend: cần cả 2 quyền.
function canViewCost(req: any): boolean {
  return (
    requestHasPermission(req, 'internal-use:view_cost_price') &&
    requestHasPermission(req, 'products:view_cost_price')
  );
}

/** Ẩn giá vốn / giá trị của phiếu khi user thiếu quyền xem giá. */
function stripInternalUseCost<T>(internalUse: T): T {
  if (!internalUse || typeof internalUse !== 'object') return internalUse;
  const iu: any = internalUse;
  return {
    ...iu,
    totalValue: undefined,
    details: Array.isArray(iu.details)
      ? iu.details.map((d: any) => ({
          ...d,
          cost: undefined,
          value: undefined,
        }))
      : iu.details,
  };
}

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
  async findAll(@Query() query: InternalUseQueryDto, @Req() req: any) {
    const result = await this.internalUseService.findAll(query);
    if (canViewCost(req)) return result;
    return {
      ...result,
      totalValue: undefined,
      data: result.data.map(stripInternalUseCost),
    };
  }

  @Get('internal-use/export')
  @RequirePermissions('internal-use:export')
  async export(
    @Query() query: InternalUseQueryDto,
    @Req() req: any,
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
      `attachment; filename=XuatDungNoiBo_${ts}.xlsx`,
    );

    await this.internalUseService.exportInternalUses(
      query,
      res,
      !canViewCost(req),
    );
  }

  @Get('internal-use/export-detail')
  @RequirePermissions('internal-use:export')
  async exportDetail(
    @Query() query: InternalUseQueryDto,
    @Req() req: any,
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

    await this.internalUseService.exportInternalUsesDetail(
      query,
      res,
      !canViewCost(req),
    );
  }

  @Get('internal-use/:id')
  @RequirePermissions('internal-use:view')
  async findOne(@Param('id') id: string, @Req() req: any) {
    const internalUse = await this.internalUseService.findOne(+id);
    return canViewCost(req) ? internalUse : stripInternalUseCost(internalUse);
  }

  @Post('internal-use')
  @RequirePermissions('internal-use:create')
  async create(@Body() dto: CreateInternalUseDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    const user = {
      permissions: req.user?.permissions || [],
      roles: req.user?.roles || [],
    };
    const internalUse = await this.internalUseService.create(dto, userId, user);
    return canViewCost(req) ? internalUse : stripInternalUseCost(internalUse);
  }

  @Put('internal-use/:id')
  @RequirePermissions('internal-use:update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateInternalUseDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    const user = {
      permissions: req.user?.permissions || [],
      roles: req.user?.roles || [],
    };
    const internalUse = await this.internalUseService.update(
      +id,
      dto,
      userId,
      user,
    );
    return canViewCost(req) ? internalUse : stripInternalUseCost(internalUse);
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
