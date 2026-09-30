import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalFinanceService } from './internal-finance.service';
import { InternalFinanceLarkImportService } from './internal-finance-lark-import.service';
import {
  CreateApprovalForWeeklyBatchDto,
  LarkFinanceImportDto,
  AddInternalFinanceAttachmentsDto,
  CreateFuelEntryDto,
  CreateManualExpenseDto,
  CreateManualReceiptDto,
  CreateVehicleCareEntryDto,
  InternalFinanceQueryDto,
  PrepareWeeklyBatchDto,
  ReviewInternalFinanceDto,
  UpdateInternalFinanceCashIssuedDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Internal Finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('internal-finance')
export class InternalFinanceController {
  constructor(
    private readonly service: InternalFinanceService,
    private readonly larkImport: InternalFinanceLarkImportService,
  ) {}

  @Get()
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'List internal finance entries' })
  findAll(@Query() query: InternalFinanceQueryDto) {
    return this.service.findAll(query);
  }

  @Get('summary')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'Summarize internal finance entries' })
  summary(@Query() query: InternalFinanceQueryDto) {
    return this.service.getSummary(query);
  }

  @Post('receipts/manual')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Create a manual internal receipt' })
  createManualReceipt(
    @Body() dto: CreateManualReceiptDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createManualReceipt(dto, user.id);
  }

  @Post('expenses/manual')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Create a manual internal expense' })
  createManualExpense(
    @Body() dto: CreateManualExpenseDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createManualExpense(dto, user.id);
  }

  @Post('vehicle/fuel')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Create a fuel entry' })
  createFuel(@Body() dto: CreateFuelEntryDto, @CurrentUser() user: any) {
    return this.service.createFuel(dto, user.id);
  }

  @Post('lark-import')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({
    summary: 'Import historical Lark finance records without posting cash',
  })
  importFromLark(@Body() dto: LarkFinanceImportDto, @CurrentUser() user: any) {
    return this.larkImport.importHistory(dto, user.id);
  }

  @Post('vehicle-care')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Create a vehicle care entry' })
  createVehicleCare(
    @Body() dto: CreateVehicleCareEntryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createVehicleCare(dto, user.id);
  }

  @Post(':id/review/:role')
  @RequirePermissions('cash_flows:update')
  @ApiOperation({ summary: 'Review an internal finance entry' })
  review(
    @Param('id', ParseIntPipe) id: number,
    @Param('role') role: string,
    @Body() dto: ReviewInternalFinanceDto,
    @CurrentUser() user: any,
  ) {
    return this.service.review(id, role, dto, user.id);
  }

  @Post(':id/accountant-review')
  @RequirePermissions('cash_flows:update')
  @ApiOperation({ summary: 'Review an internal finance entry as accountant' })
  accountantReview(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewInternalFinanceDto,
    @CurrentUser() user: any,
  ) {
    return this.service.review(id, 'accountant', dto, user.id);
  }

  @Post(':id/manager-review')
  @RequirePermissions('cash_flows:update')
  @ApiOperation({ summary: 'Review an internal finance entry as manager' })
  managerReview(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewInternalFinanceDto,
    @CurrentUser() user: any,
  ) {
    return this.service.review(id, 'manager', dto, user.id);
  }

  @Post(':id/attachments')
  @RequirePermissions('cash_flows:update')
  @ApiOperation({
    summary: 'Add evidence attachments to an internal finance entry',
  })
  addAttachments(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddInternalFinanceAttachmentsDto,
    @CurrentUser() user: any,
  ) {
    return this.service.addAttachments(id, dto, user.id);
  }

  @Post(':id/post')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Post one internal finance entry to CashFlow' })
  postEntry(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.service.postEntry(id, user.id);
  }

  @Patch(':id/cash-issued')
  @RequirePermissions('cash_flows:update')
  @ApiOperation({ summary: 'Mark an expense as cash issued without creating CashFlow' })
  updateCashIssued(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInternalFinanceCashIssuedDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateCashIssued(id, dto.cashIssued, user.id);
  }

  @Post('maintenance/normalize-codes')
  @RequirePermissions('cash_flows:update')
  @ApiOperation({ summary: 'Normalize legacy internal finance codes' })
  normalizeLegacyCodes() {
    return this.service.normalizeLegacyCodes();
  }

  @Get('weekly-batches')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'List weekly internal finance batches' })
  weeklyBatches(@Query() query: InternalFinanceQueryDto) {
    return this.service.findWeeklyBatches(query);
  }

  @Get('weekly-batches/:id')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'Get one weekly internal finance batch' })
  weeklyBatch(@Param('id', ParseIntPipe) id: number) {
    return this.service.findWeeklyBatch(id);
  }

  @Post('weekly-batches/prepare')
  @RequirePermissions('cash_flows:update')
  @ApiOperation({ summary: 'Prepare a weekly internal finance batch' })
  prepareWeeklyBatch(
    @Body() dto: PrepareWeeklyBatchDto,
    @CurrentUser() user: any,
  ) {
    return this.service.prepareWeeklyBatch(dto, user.id);
  }

  @Post('weekly-batches/:id/create-approval')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Create the weekly Lark Approval' })
  createWeeklyApproval(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateApprovalForWeeklyBatchDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createWeeklyApproval(
      id,
      user.id,
      dto.detailUrl,
      dto.viewUrl,
    );
  }

  @Post('weekly-batches/:id/post')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Post all approved weekly entries to CashFlow' })
  postWeeklyBatch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.service.postWeeklyBatch(id, user.id);
  }
}
