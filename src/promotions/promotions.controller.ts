import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
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
