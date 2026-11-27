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
import { NPP_STAGE, NppStage, PERM } from './new-product-price.constants';
import { NewProductPriceService, NppUser } from './new-product-price.service';
import { NewProductPriceApplyService } from './new-product-price-apply.service';
import { NewProductPriceConfigService } from './new-product-price-config.service';
import { NewProductPriceReminderCron } from './new-product-price-reminder.cron';
import { MisaDictionaryService } from '../misa-sync/misa-dictionary.service';
import {
  CreateNppDto,
  NppCommentDto,
  NppConfigDto,
  NppCustomerSearchDto,
  NppDecisionDto,
  NppQueryDto,
  NppReasonDto,
  UpdateNppDto,
} from './dto';

const REMINDER_STAGES: NppStage[] = [
  NPP_STAGE.PURCHASING,
  NPP_STAGE.ACCOUNTING,
  NPP_STAGE.SALES,
  NPP_STAGE.CEO,
];

@ApiTags('New Product Price')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('new-product-prices')
export class NewProductPriceController {
  constructor(
    private readonly service: NewProductPriceService,
    private readonly applyService: NewProductPriceApplyService,
    private readonly configService: NewProductPriceConfigService,
    private readonly reminders: NewProductPriceReminderCron,
    private readonly misaDictionary: MisaDictionaryService,
  ) {}

  @Get()
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({ summary: 'Danh sách phiếu bảng giá sản phẩm mới' })
  findAll(@Query() query: NppQueryDto, @CurrentUser() user: NppUser) {
    return this.service.findAll(query, user);
  }

  @Get('summary')
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({ summary: 'Đếm phiếu theo bước' })
  summary(@Query() query: NppQueryDto, @CurrentUser() user: NppUser) {
    return this.service.getSummary(query, user);
  }

  @Get('reference')
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({
    summary: 'Danh mục, thương hiệu, đơn vị, bảng giá, chi nhánh cho form',
  })
  reference() {
    return this.service.getReference();
  }

  @Get('reference/customers')
  @RequirePermissions(PERM.VIEW)
  customers(@Query() query: NppCustomerSearchDto) {
    return this.service.searchCustomers(query.search);
  }

  /** Vật tư Misa cho ô "Mã Misa" (phòng ban có thể không có quyền liên kết Misa). */
  @Get('reference/misa-items')
  @RequirePermissions(PERM.VIEW)
  misaItems(@Query() query: NppCustomerSearchDto) {
    return this.misaDictionary.findInventoryItems(query.search, 50);
  }

  @Get('config')
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({ summary: 'Cấu hình người duyệt & đích áp dụng giá' })
  getConfig() {
    return this.service.getConfigView();
  }

  @Put('config')
  @RequirePermissions(PERM.CONFIG)
  async updateConfig(@Body() dto: NppConfigDto, @CurrentUser() user: NppUser) {
    await this.configService.update(dto, user);
    return this.service.getConfigView();
  }

  @Post('reminders/run')
  @RequirePermissions(PERM.CONFIG)
  @ApiOperation({ summary: 'Chạy nhắc việc ngay (kiểm tra)' })
  runReminders(@Query('stage') stage?: string) {
    if (stage && !REMINDER_STAGES.includes(stage as NppStage)) {
      throw new BadRequestException('Bước nhắc việc không hợp lệ');
    }
    return this.reminders.runStages(
      stage ? [stage as NppStage] : REMINDER_STAGES,
      true,
    );
  }

  @Get('by-code/:code')
  @RequirePermissions(PERM.VIEW)
  async findByCode(@Param('code') code: string, @CurrentUser() user: NppUser) {
    const id = await this.service.findIdByCode(code);
    if (!id) throw new BadRequestException('Không tìm thấy phiếu');
    return this.service.findOne(id, user);
  }

  @Get(':id')
  @RequirePermissions(PERM.VIEW)
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: NppUser) {
    return this.service.findOne(id, user);
  }

  @Post()
  @RequirePermissions(PERM.CREATE)
  @ApiOperation({ summary: 'Tạo đề xuất sản phẩm mới' })
  create(@Body() dto: CreateNppDto, @CurrentUser() user: NppUser) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions(PERM.VIEW)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateNppDto,
    @CurrentUser() user: NppUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Post(':id/complete')
  @RequirePermissions(PERM.VIEW)
  complete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: NppUser,
  ) {
    return this.service.complete(id, user);
  }

  @Post(':id/send-back')
  @RequirePermissions(PERM.VIEW)
  sendBack(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: NppReasonDto,
    @CurrentUser() user: NppUser,
  ) {
    return this.service.sendBack(id, dto.reason, user);
  }

  @Post(':id/chief-accountant/send')
  @RequirePermissions(PERM.VIEW)
  sendKtt(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: NppUser) {
    return this.service.sendToChiefAccountant(id, user);
  }

  @Post(':id/chief-accountant/decision')
  @RequirePermissions(PERM.VIEW)
  kttDecision(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: NppDecisionDto,
    @CurrentUser() user: NppUser,
  ) {
    return this.service.chiefAccountantDecision(id, dto, user);
  }

  @Post(':id/ceo/decision')
  @RequirePermissions(PERM.VIEW)
  ceoDecision(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: NppDecisionDto,
    @CurrentUser() user: NppUser,
  ) {
    return this.service.ceoDecision(id, dto, user);
  }

  @Get(':id/apply-preview')
  @RequirePermissions(PERM.VIEW)
  applyPreview(@Param('id', ParseIntPipe) id: number) {
    return this.applyService.preview(id);
  }

  @Post(':id/apply')
  @RequirePermissions(PERM.VIEW)
  @ApiOperation({ summary: 'Áp dụng tạo sản phẩm mới (bước Phòng Dữ Liệu)' })
  apply(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: NppUser) {
    return this.applyService.apply(id, user);
  }

  @Post(':id/end')
  @RequirePermissions(PERM.VIEW)
  end(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: NppReasonDto,
    @CurrentUser() user: NppUser,
  ) {
    return this.service.end(id, dto.reason, user);
  }

  @Post(':id/comments')
  @RequirePermissions(PERM.VIEW)
  comment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: NppCommentDto,
    @CurrentUser() user: NppUser,
  ) {
    return this.service.addComment(id, dto, user);
  }
}
