import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PromotionsService } from './promotions.service';
import {
  CreatePromotionDto,
  UpdatePromotionDto,
  EvaluatePromotionDto,
  PromotionQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Promotions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('promotions')
export class PromotionsController {
  constructor(private promotionsService: PromotionsService) {}

  @Get()
  @RequirePermissions('promotions:view')
  findAll(@Query() query: PromotionQueryDto) {
    return this.promotionsService.findAll(query);
  }

  @Get('export')
  @RequirePermissions('promotions:export')
  @ApiOperation({
    summary:
      'Xuất Excel TỔNG QUAN chương trình khuyến mãi theo bộ lọc hiện tại (mỗi CTKM 1 dòng).',
  })
  async export(@Query() query: PromotionQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=KhuyenMai_${ts}.xlsx`,
    );

    await this.promotionsService.exportPromotions(query, res);
  }

  @Get('export-detail')
  @RequirePermissions('promotions:export')
  @ApiOperation({
    summary:
      'Xuất Excel CHI TIẾT chương trình khuyến mãi theo bộ lọc hiện tại (mỗi dòng reward 1 dòng).',
  })
  async exportDetail(@Query() query: PromotionQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=KhuyenMai_ChiTiet_${ts}.xlsx`,
    );

    await this.promotionsService.exportPromotionsDetail(query, res);
  }

  @Post('evaluate')
  @ApiOperation({
    summary: 'Kiểm tra khuyến mãi áp dụng cho giỏ hàng hiện tại',
  })
  evaluate(@Body() dto: EvaluatePromotionDto) {
    return this.promotionsService.evaluate(dto);
  }

  @Get(':id')
  @RequirePermissions('promotions:view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.findOne(id);
  }

  @Get(':id/logs')
  @RequirePermissions('promotions:view')
  getLogs(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.getLogs(id);
  }

  @Get(':id/usage')
  @RequirePermissions('promotions:view')
  getUsage(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.getUsage(id);
  }

  @Get(':id/stats')
  @RequirePermissions('promotions:view')
  getStats(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.getStats(id);
  }

  @Post()
  @RequirePermissions('promotions:create')
  create(@Body() dto: CreatePromotionDto, @CurrentUser() user: any) {
    return this.promotionsService.create(dto, user.id);
  }

  @Put(':id')
  @RequirePermissions('promotions:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePromotionDto,
    @CurrentUser() user: any,
  ) {
    return this.promotionsService.update(id, dto, user.id);
  }

  @Patch(':id/toggle')
  @RequirePermissions('promotions:update')
  toggle(
    @Param('id', ParseIntPipe) id: number,
    @Body('isActive') isActive: boolean,
  ) {
    return this.promotionsService.toggle(id, isActive);
  }

  @Patch(':id/stop')
  @RequirePermissions('promotions:update')
  stop(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.stop(id);
  }
}
