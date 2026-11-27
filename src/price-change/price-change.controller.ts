import {
  BadRequestException,
  Body,
  Controller,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERM, PcStage, REMINDER_STAGES } from './price-change.constants';
import { PcUser, PriceChangeService } from './price-change.service';
import { PriceChangeApplyService } from './price-change-apply.service';
import { PriceChangeConfigService } from './price-change-config.service';
import { PriceChangeReferenceService } from './price-change-reference.service';
import { PriceChangeReminderCron } from './price-change-reminder.cron';
import {
  CreatePcDto,
  PcCommentDto,
  PcConfigDto,
  PcCurrentValuesDto,
  PcDecisionDto,
  PcQueryDto,
  PcReasonDto,
  UpdatePcDto,
} from './dto';

@ApiTags('Price Change')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('price-changes')
export class PriceChangeController {
  constructor(
    private readonly service: PriceChangeService,
    private readonly applyService: PriceChangeApplyService,
    private readonly configService: PriceChangeConfigService,
    private readonly reference: PriceChangeReferenceService,
    private readonly reminders: PriceChangeReminderCron,
  ) {}

  @Get()
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({ summary: 'Danh sách phiếu thay đổi giá' })
  findAll(@Query() query: PcQueryDto, @CurrentUser() user: PcUser) {
    return this.service.findAll(query, user);
  }

  @Get('summary')
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({ summary: 'Đếm phiếu theo bước' })
  summary(@Query() query: PcQueryDto, @CurrentUser() user: PcUser) {
    return this.service.getSummary(query, user);
  }

  @Get('reference')
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({
    summary: 'Chi nhánh, bảng giá, người đề xuất cho form / bộ lọc',
  })
  getReference() {
    return this.reference.getReference();
  }

  @Get('reference/current-values')
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({ summary: 'Giá vốn / giá bán hiện tại của các sản phẩm' })
  currentValues(@Query() query: PcCurrentValuesDto) {
    if (query.productIds.length > 300)
      throw new BadRequestException('Tối đa 300 sản phẩm mỗi lần');
    return this.reference.currentValues(
      query.productIds,
      query.branchIds ?? [],
      query.priceBookIds ?? [],
    );
  }

  @Get('config')
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({ summary: 'Cấu hình người duyệt từng bước' })
  getConfig() {
    return this.service.getConfigView();
  }

  @Put('config')
  @RequirePermissions(PERM.CONFIG)
  async updateConfig(@Body() dto: PcConfigDto, @CurrentUser() user: PcUser) {
    await this.configService.update(dto, user);
    return this.service.getConfigView();
  }

  @Post('reminders/run')
  @RequirePermissions(PERM.CONFIG)
  @ApiOperation({
    summary: 'Gửi nhắc việc ngay (kể cả khi đang tắt nhắc việc)',
  })
  runReminders(@Query('stage') stage?: string) {
    if (stage && !REMINDER_STAGES.includes(stage as PcStage))
      throw new BadRequestException('Bước nhắc việc không hợp lệ');
    return this.reminders.runStages(
      stage ? [stage as PcStage] : REMINDER_STAGES,
      true,
    );
  }

  @Get('by-code/:code')
  @RequirePermissions(PERM.VIEW)
  async findByCode(@Param('code') code: string, @CurrentUser() user: PcUser) {
    const id = await this.service.findIdByCode(code);
    if (!id) throw new BadRequestException('Không tìm thấy phiếu');
    return this.service.findOne(id, user);
  }

  @Get(':id')
  @RequirePermissions(PERM.VIEW)
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: PcUser) {
    return this.service.findOne(id, user);
  }

  @Post()
  @RequirePermissions(PERM.CREATE)
  @ApiOperation({ summary: 'Tạo phiếu thay đổi giá' })
  create(@Body() dto: CreatePcDto, @CurrentUser() user: PcUser) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions(PERM.VIEW)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePcDto,
    @CurrentUser() user: PcUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Post(':id/submit')
  @RequirePermissions(PERM.VIEW)
  submit(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: PcUser) {
    return this.service.submit(id, user);
  }

  @Post(':id/ktt/decision')
  @RequirePermissions(PERM.VIEW)
  kttDecision(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PcDecisionDto,
    @CurrentUser() user: PcUser,
  ) {
    return this.service.kttDecision(id, dto, user);
  }

  @Post(':id/ceo/decision')
  @RequirePermissions(PERM.VIEW)
  ceoDecision(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PcDecisionDto,
    @CurrentUser() user: PcUser,
  ) {
    return this.service.ceoDecision(id, dto, user);
  }

  @Post(':id/send-back')
  @RequirePermissions(PERM.VIEW)
  sendBack(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PcReasonDto,
    @CurrentUser() user: PcUser,
  ) {
    return this.service.sendBack(id, dto.reason, user);
  }

  @Get(':id/apply-preview')
  @RequirePermissions(PERM.VIEW)
  applyPreview(@Param('id', ParseIntPipe) id: number) {
    return this.applyService.preview(id);
  }

  @Post(':id/apply')
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({ summary: 'Áp dụng thay đổi giá (bước Phòng Dữ Liệu)' })
  apply(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: PcUser) {
    return this.applyService.apply(id, user);
  }

  @Post(':id/end')
  @RequirePermissions(PERM.VIEW)
  end(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PcReasonDto,
    @CurrentUser() user: PcUser,
  ) {
    return this.service.end(id, dto.reason, user);
  }

  @Post(':id/comments')
  @RequirePermissions(PERM.VIEW)
  addComment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PcCommentDto,
    @CurrentUser() user: PcUser,
  ) {
    return this.service.addComment(id, dto, user);
  }
}
