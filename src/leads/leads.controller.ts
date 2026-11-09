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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { requestHasPermission } from '../auth/request-permissions';
import { LeadActor, LeadsService } from './leads.service';
import { JourneyViewer, LeadLinkService } from './lead-link/lead-link.service';
import {
  ConvertLeadDto,
  HandoverCheckQueryDto,
  HandoverLeadDto,
  LeadConversationDto,
  LeadListQueryDto,
  LeadTemplatesDto,
  RetryHandoverDto,
  UpsertLeadDto,
} from './dto/lead.dto';

@ApiTags('Leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly service: LeadsService,
    private readonly leadLink: LeadLinkService,
  ) {}

  // Chỉ có leads:view (Sale) → chỉ thấy lead giao cho mình; leads:update (CSKH) → mọi lead
  private actor(req: any): LeadActor {
    return {
      id: req.user.id,
      name: req.user.name,
      ownOnly: !requestHasPermission(req, 'leads:update'),
    };
  }

  private viewer(req: any): JourneyViewer {
    const a = this.actor(req);
    return { canViewLeads: true, ownOnly: a.ownOnly, userId: a.id };
  }

  @Get()
  @RequirePermissions('leads:view')
  list(@Query() q: LeadListQueryDto, @Req() req: any) {
    return this.service.list(q, this.actor(req));
  }

  @Get('check-phone')
  @RequirePermissions('leads:view')
  checkPhone(
    @Query('phone') phone: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.service.checkPhone(
      phone,
      excludeId ? Number(excludeId) : undefined,
    );
  }

  // Hành trình khách (tab "Hành trình" ở trang khách hàng): lead nguồn + mã KH + đơn / hóa đơn
  @Get('by-customer/:customerId/journey')
  @RequirePermissions('leads:view')
  customerJourney(
    @Param('customerId', ParseIntPipe) customerId: number,
    @Req() req: any,
  ) {
    return this.leadLink.journey({ customerId }, this.viewer(req));
  }

  @Get('sales')
  @RequirePermissions('leads:assign')
  saleCandidates() {
    return this.service.saleCandidates();
  }

  @Get('channels')
  @RequirePermissions('leads:view')
  channels() {
    return this.service.channels();
  }

  /** Tên kênh tự nhập đã dùng của 1 nguồn (vd "Khác") — gợi ý khi tạo kênh mới. */
  @Get('channel-names')
  @RequirePermissions('leads:view')
  channelNames(@Query('source') source: string) {
    return this.service.channelNames(source);
  }

  @Get('templates')
  @RequirePermissions('leads:view')
  templates() {
    return this.service.templates();
  }

  @Put('templates')
  @RequirePermissions('settings:update')
  saveTemplates(@Body() dto: LeadTemplatesDto, @Req() req: any) {
    return this.service.saveTemplates(dto, this.actor(req));
  }

  @Post('handovers/:handoverId/retry')
  @RequirePermissions('leads:assign')
  retry(
    @Param('handoverId', ParseIntPipe) handoverId: number,
    @Body() dto: RetryHandoverDto,
    @Req() req: any,
  ) {
    return this.service.retryHandover(
      handoverId,
      dto.confirmed,
      this.actor(req),
    );
  }

  @Post('handovers/:handoverId/confirm-phone')
  @RequirePermissions('leads:assign')
  confirmPhone(
    @Param('handoverId', ParseIntPipe) handoverId: number,
    @Body() dto: RetryHandoverDto,
    @Req() req: any,
  ) {
    return this.service.confirmHandoverPhone(
      handoverId,
      dto.confirmed,
      this.actor(req),
    );
  }

  @Get(':id/journey')
  @RequirePermissions('leads:view')
  journey(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.leadLink.journey({ leadId: id }, this.viewer(req));
  }

  @Get(':id')
  @RequirePermissions('leads:view')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.get(id, this.actor(req));
  }

  @Post()
  @RequirePermissions('leads:update')
  create(@Body() dto: UpsertLeadDto, @Req() req: any) {
    return this.service.create(dto, this.actor(req));
  }

  @Patch(':id')
  @RequirePermissions('leads:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertLeadDto,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, this.actor(req));
  }

  @Post(':id/conversations')
  @RequirePermissions('leads:update')
  addConversation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LeadConversationDto,
    @Req() req: any,
  ) {
    return this.service.addConversation(id, dto, this.actor(req));
  }

  @Delete(':id/conversations/:conversationId')
  @RequirePermissions('leads:update')
  removeConversation(
    @Param('id', ParseIntPipe) id: number,
    @Param('conversationId', ParseIntPipe) conversationId: number,
  ) {
    return this.service.removeConversation(id, conversationId);
  }

  @Post(':id/convert')
  @RequirePermissions('leads:update')
  convert(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConvertLeadDto,
    @Req() req: any,
  ) {
    return this.service.convert(
      id,
      dto.customerId,
      this.actor(req),
      dto.method,
    );
  }

  @Post(':id/unlink')
  @RequirePermissions('leads:update')
  unlink(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.unlink(id, this.actor(req));
  }

  @Get(':id/handover-check')
  @RequirePermissions('leads:view')
  handoverCheck(
    @Param('id', ParseIntPipe) id: number,
    @Query() q: HandoverCheckQueryDto,
  ) {
    return this.service.handoverCheck(id, q.salePicId, q.pagePid);
  }

  @Get(':id/handover-preview')
  @RequirePermissions('leads:assign')
  handoverPreview(
    @Param('id', ParseIntPipe) id: number,
    @Query('salePicId', ParseIntPipe) salePicId: number,
    @Query('note') note?: string,
  ) {
    return this.service.handoverPreview(id, salePicId, note);
  }

  @Post(':id/handover')
  @RequirePermissions('leads:assign')
  handover(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: HandoverLeadDto,
    @Req() req: any,
  ) {
    return this.service.handover(id, dto, this.actor(req));
  }
}
