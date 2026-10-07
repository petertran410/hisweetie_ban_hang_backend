import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import {
  ConfirmInternalUseReturnDto,
  CreateInternalUseReturnDto,
  InternalUseReturnQueryDto,
  UpdateInternalUseReturnDto,
} from './dto';
import { InternalUseReturnsService } from './internal-use-returns.service';

@ApiTags('Internal Use Returns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('internal-use-returns')
export class InternalUseReturnsController {
  constructor(private readonly service: InternalUseReturnsService) {}

  @Get()
  @RequirePermissions('internal-use-returns:view')
  findAll(@Query() query: InternalUseReturnQueryDto) {
    return this.service.findAll(query);
  }

  @Get('returnable/:internalUseId')
  @RequirePermissions('internal-use-returns:view')
  getReturnable(
    @Param('internalUseId', ParseIntPipe) internalUseId: number,
  ) {
    return this.service.getReturnable(internalUseId);
  }

  @Get('export')
  @RequirePermissions('internal-use-returns:export')
  async export(@Query() query: InternalUseReturnQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=TraHangXuatDungNoiBo_${ts}.xlsx`,
    );
    await this.service.exportReturns(query, res, false);
  }

  @Get('export-detail')
  @RequirePermissions('internal-use-returns:export')
  async exportDetail(
    @Query() query: InternalUseReturnQueryDto,
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
      `attachment; filename=TraHangXuatDungNoiBo_ChiTiet_${ts}.xlsx`,
    );
    await this.service.exportReturns(query, res, true);
  }

  @Get(':id')
  @RequirePermissions('internal-use-returns:view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermissions('internal-use-returns:create')
  create(
    @Body() dto: CreateInternalUseReturnDto,
    @CurrentUser() user: any,
  ) {
    return this.service.create(dto, user.id);
  }

  @Put(':id/update-step1')
  @RequirePermissions('internal-use-returns:update')
  updateStep1(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInternalUseReturnDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateStep1(id, dto, user.id);
  }

  @Put(':id/confirm-stock')
  @RequirePermissions('internal-use-returns:update')
  confirmStock(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmInternalUseReturnDto,
    @CurrentUser() user: any,
  ) {
    return this.service.confirmStock(id, dto, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('internal-use-returns:cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.service.cancel(id, user.id);
  }
}

