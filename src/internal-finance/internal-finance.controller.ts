import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalFinanceService } from './internal-finance.service';
import { WarehouseExpenseNotesService } from './warehouse-expense-notes.service';
import {
  CreateApprovalForWeeklyBatchDto,
  CreateWarehouseExpenseDto,
  AddInternalFinanceAttachmentsDto,
  CreateFuelEntryDto,
  CreateManualExpenseDto,
  CreateManualReceiptDto,
  CreateVehicleCareEntryDto,
  CreateWarehouseReceiptDto,
  CancelWarehouseReceiptDto,
  CancelWarehouseExpenseDto,
  CreateWarehouseExpenseNoteDto,
  InternalFinanceQueryDto,
  LarkApprovalQueryDto,
  CheckWarehouseExpenseDto,
  AddWeeklyBatchEntriesDto,
  BulkCheckWarehouseExpenseDto,
  MarkWarehouseExpenseIssuedDto,
  PostWarehouseReceiptDto,
  WarehouseExpenseQueryDto,
  PrepareWeeklyBatchDto,
  ReviewInternalFinanceDto,
  UpdateInternalFinanceCashIssuedDto,
  UpdateWarehouseReceiptDto,
  UpdateWarehouseExpenseDto,
  UpdateVehicleEntryDto,
  VehicleEntryQueryDto,
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
    private readonly notes: WarehouseExpenseNotesService,
  ) {}

  // Giới hạn truy vấn về các chi nhánh user được phép; ngoài phạm vi thì từ chối.
  private scopeBranches<T extends { branchIds?: number[] }>(
    query: T,
    allowed: number[],
  ): T {
    const requested = query.branchIds?.length
      ? query.branchIds.map(Number).filter((id) => allowed.includes(id))
      : allowed;
    if (!requested.length)
      throw new ForbiddenException('Không có quyền xem dữ liệu chi nhánh này');
    return { ...query, branchIds: requested };
  }

  @Get('access')
  @ApiOperation({
    summary: 'Quyền tài chính của user tại từng chi nhánh được truy cập',
  })
  access(@CurrentUser() user: any) {
    return this.service.financeAccessSummary(user);
  }

  @Get()
  @ApiOperation({ summary: 'List internal finance entries' })
  async findAll(
    @Query() query: InternalFinanceQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.findAll(
      this.scopeBranches(query, await this.service.financeViewBranches(user)),
    );
  }

  @Get('summary')
  @ApiOperation({ summary: 'Summarize internal finance entries' })
  async summary(
    @Query() query: InternalFinanceQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.getSummary(
      this.scopeBranches(query, await this.service.financeViewBranches(user)),
    );
  }

  @Get('warehouse-receipts')
  @ApiOperation({ summary: 'List warehouse cash receipts' })
  async warehouseReceipts(
    @Query() query: InternalFinanceQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.listWarehouseReceipts(
      this.scopeBranches(
        query,
        await this.service.warehouseCashBranches(user, 'view'),
      ),
    );
  }

  @Get('warehouse-receipts/:id')
  @ApiOperation({ summary: 'Get one warehouse cash receipt' })
  async warehouseReceipt(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    await this.service.assertWarehouseCashEntry(user, 'view', id);
    return this.service.getWarehouseReceipt(id);
  }

  @Get('warehouse-expenses')
  @ApiOperation({ summary: 'List warehouse expense entries' })
  warehouseExpenses(
    @Query() query: WarehouseExpenseQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.listWarehouseExpenses(query, user);
  }

  @Post('warehouse-expenses/manual')
  @ApiOperation({ summary: 'Create a manual warehouse expense' })
  createWarehouseExpense(
    @Body() dto: CreateWarehouseExpenseDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createWarehouseExpense(dto, user);
  }

  @Get('warehouse-expenses/payer-summary')
  @ApiOperation({ summary: 'Warehouse expense totals by payer' })
  warehouseExpensePayerSummary(
    @Query() query: WarehouseExpenseQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.warehouseExpensePayerSummary(query, user);
  }

  // Khai báo trước `warehouse-expenses/:id` để không bị khớp nhầm thành id.
  @Patch('warehouse-expenses/check-bulk')
  @ApiOperation({ summary: 'Tick a check on many warehouse expenses' })
  bulkCheckWarehouseExpenses(
    @Body() dto: BulkCheckWarehouseExpenseDto,
    @CurrentUser() user: any,
  ) {
    return this.service.bulkCheckWarehouseExpenses(user, dto);
  }

  @Patch('warehouse-expenses/:id')
  @ApiOperation({ summary: 'Update an open manual warehouse expense' })
  updateWarehouseExpense(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWarehouseExpenseDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateWarehouseExpense(id, dto, user);
  }

  @Get('warehouse-expenses/weekly-batches')
  @ApiOperation({ summary: 'List warehouse expense weekly batches' })
  warehouseExpenseBatches(
    @Query() query: InternalFinanceQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.listWarehouseExpenseBatches(query, user);
  }

  @Get('lark-approvals')
  @ApiOperation({ summary: 'Lark Approval forms created directly on Lark' })
  larkApprovals(
    @Query() query: LarkApprovalQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.listLarkApprovals(query, user);
  }

  @Get('warehouse-expenses/weekly-batch-pages')
  @ApiOperation({ summary: 'Paged warehouse expense weekly batches' })
  warehouseExpenseBatchPage(
    @Query() query: InternalFinanceQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.pageWarehouseExpenseBatches(query, user);
  }

  @Get('warehouse-expenses/weekly-carry-over')
  @ApiOperation({ summary: 'Expenses left out of earlier weekly batches' })
  warehouseCarryOver(
    @Query('branchId', ParseIntPipe) branchId: number,
    @Query('weekStart') weekStart: string,
    @CurrentUser() user: any,
  ) {
    return this.service.warehouseCarryOver(user, branchId, weekStart);
  }

  @Get('warehouse-expenses/weekly-batches/:id')
  @ApiOperation({ summary: 'Get a warehouse expense weekly batch' })
  warehouseExpenseBatch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.service.getWarehouseExpenseBatch(id, user);
  }

  @Post('warehouse-expenses/weekly-batches/prepare')
  @ApiOperation({ summary: 'Prepare a warehouse expense weekly batch' })
  prepareWarehouseExpenseBatch(
    @Body() dto: PrepareWeeklyBatchDto,
    @CurrentUser() user: any,
  ) {
    return this.service.prepareWarehouseExpenseBatch(dto, user);
  }

  @Post('warehouse-expenses/weekly-batches/:id/create-approval')
  @ApiOperation({ summary: 'Create a warehouse expense Lark Approval' })
  createWarehouseExpenseApproval(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateApprovalForWeeklyBatchDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createWarehouseExpenseApproval(
      id,
      user,
      dto.detailUrl,
      dto.viewUrl,
    );
  }

  @Post('warehouse-expenses/weekly-batches/:id/add-entries')
  @ApiOperation({ summary: 'Add carried-over expenses to a weekly batch' })
  addCarryOverEntries(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddWeeklyBatchEntriesDto,
    @CurrentUser() user: any,
  ) {
    return this.service.addCarryOverEntries(id, dto.entryIds, user);
  }

  @Post('warehouse-expenses/weekly-batches/:id/remove-entries')
  @ApiOperation({ summary: 'Remove expenses from a weekly batch not yet sent' })
  removeWeeklyBatchEntries(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddWeeklyBatchEntriesDto,
    @CurrentUser() user: any,
  ) {
    return this.service.removeWeeklyBatchEntries(id, dto.entryIds, user);
  }

  @Post('warehouse-expenses/weekly-batches/:id/cancel')
  @ApiOperation({ summary: 'Cancel a warehouse expense weekly batch' })
  cancelWarehouseExpenseBatch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.service.cancelWarehouseExpenseBatch(id, user);
  }

  @Put('warehouse-expenses/:id/cancel')
  @ApiOperation({ summary: 'Cancel a warehouse expense with a reason' })
  cancelWarehouseExpense(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelWarehouseExpenseDto,
    @CurrentUser() user: any,
  ) {
    return this.service.cancelWarehouseExpense(id, user, dto.reason);
  }

  @Get('warehouse-expenses/:id/notes')
  @ApiOperation({ summary: 'List review notes of a warehouse expense' })
  warehouseExpenseNotes(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.notes.list(id, user);
  }

  @Get('warehouse-expenses/:id/mention-candidates')
  @ApiOperation({ summary: 'Users that can be tagged to review an expense' })
  warehouseExpenseMentionCandidates(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.notes.mentionCandidates(id, user);
  }

  @Post('warehouse-expenses/:id/notes')
  @ApiOperation({
    summary: 'Add a review note and notify tagged users on Lark',
  })
  createWarehouseExpenseNote(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateWarehouseExpenseNoteDto,
    @CurrentUser() user: any,
  ) {
    return this.notes.create(id, dto, user);
  }

  @Patch('warehouse-expenses/:id/mark-issued')
  @ApiOperation({ summary: 'Mark a warehouse expense as issued and post cash' })
  markWarehouseExpenseIssued(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MarkWarehouseExpenseIssuedDto,
    @CurrentUser() user: any,
  ) {
    return this.service.markWarehouseExpenseIssued(id, user, dto);
  }

  @Patch('warehouse-expenses/:id/check')
  @ApiOperation({ summary: 'Tick or untick a warehouse expense check' })
  checkWarehouseExpense(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CheckWarehouseExpenseDto,
    @CurrentUser() user: any,
  ) {
    return this.service.checkWarehouseExpense(id, user, dto);
  }

  @Post('warehouse-receipts')
  @ApiOperation({ summary: 'Create a manual warehouse cash receipt' })
  async createWarehouseReceipt(
    @Body() dto: CreateWarehouseReceiptDto,
    @CurrentUser() user: any,
  ) {
    await this.service.assertWarehouseCash(user, 'create', dto.branchId);
    return this.service.createWarehouseReceipt(dto, user.id);
  }

  @Patch('warehouse-receipts/:id')
  @ApiOperation({ summary: 'Update an open warehouse cash receipt' })
  async updateWarehouseReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWarehouseReceiptDto,
    @CurrentUser() user: any,
  ) {
    await this.service.assertWarehouseCashEntry(user, 'update', id);
    // Chuyển phiếu sang kho khác thì cũng phải có quyền ở kho đó.
    if (dto.branchId)
      await this.service.assertWarehouseCash(user, 'update', dto.branchId);
    return this.service.updateWarehouseReceipt(id, dto, user.id);
  }

  @Post('warehouse-receipts/:id/post')
  @ApiOperation({ summary: 'Allocate and create cash receipts' })
  async postWarehouseReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PostWarehouseReceiptDto,
    @CurrentUser() user: any,
  ) {
    await this.service.assertWarehouseCashEntry(user, 'post', id);
    return this.service.postWarehouseReceipt(id, dto, user.id);
  }

  @Put('warehouse-receipts/:id/cancel')
  @ApiOperation({ summary: 'Cancel a warehouse cash receipt' })
  async cancelWarehouseReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelWarehouseReceiptDto,
    @CurrentUser() user: any,
  ) {
    await this.service.assertWarehouseCashEntry(user, 'cancel', id);
    return this.service.cancelWarehouseReceipt(id, dto, user.id);
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
  @ApiOperation({ summary: 'Create a manual internal expense' })
  createManualExpense(
    @Body() dto: CreateManualExpenseDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createManualExpense(dto, user);
  }

  @Post('vehicle/fuel')
  @ApiOperation({ summary: 'Create a fuel entry' })
  createFuel(@Body() dto: CreateFuelEntryDto, @CurrentUser() user: any) {
    return this.service.createFuel(dto, user);
  }

  @Post('vehicle-care')
  @ApiOperation({ summary: 'Create a vehicle care entry' })
  createVehicleCare(
    @Body() dto: CreateVehicleCareEntryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createVehicleCare(dto, user);
  }

  @Get('vehicle-entries')
  @ApiOperation({ summary: 'List fuel or vehicle care entries with metrics' })
  vehicleEntries(
    @Query() query: VehicleEntryQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.listVehicleEntries(query, user);
  }

  @Patch('vehicle-entries/:id')
  @ApiOperation({ summary: 'Update an open fuel or vehicle care entry' })
  updateVehicleEntry(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateVehicleEntryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateVehicleEntry(id, dto, user);
  }

  @Put('vehicle-entries/:id/cancel')
  @ApiOperation({ summary: 'Cancel an open fuel or vehicle care entry' })
  cancelVehicleEntry(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelWarehouseExpenseDto,
    @CurrentUser() user: any,
  ) {
    return this.service.cancelVehicleEntry(id, user, dto.reason);
  }

  @Post(':id/review/:role')
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
  @ApiOperation({ summary: 'Review an internal finance entry as accountant' })
  accountantReview(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewInternalFinanceDto,
    @CurrentUser() user: any,
  ) {
    return this.service.review(id, 'accountant', dto, user.id);
  }

  @Post(':id/manager-review')
  @ApiOperation({ summary: 'Review an internal finance entry as manager' })
  managerReview(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewInternalFinanceDto,
    @CurrentUser() user: any,
  ) {
    return this.service.review(id, 'manager', dto, user.id);
  }

  @Post(':id/attachments')
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
  @ApiOperation({
    summary: 'Mark an expense as cash issued without creating CashFlow',
  })
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
