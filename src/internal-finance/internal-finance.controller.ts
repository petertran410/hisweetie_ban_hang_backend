import {
  Body,
  Controller,
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
import { InternalFinanceLarkImportService } from './internal-finance-lark-import.service';
import {
  CreateApprovalForWeeklyBatchDto,
  CreateWarehouseExpenseDto,
  LarkFinanceImportDto,
  AddInternalFinanceAttachmentsDto,
  CreateFuelEntryDto,
  CreateManualExpenseDto,
  CreateManualReceiptDto,
  CreateVehicleCareEntryDto,
  CreateWarehouseReceiptDto,
  CancelWarehouseReceiptDto,
  InternalFinanceQueryDto,
  MarkWarehouseExpenseIssuedDto,
  PostWarehouseReceiptDto,
  WarehouseCashImportDto,
  WarehouseExpenseQueryDto,
  PrepareWeeklyBatchDto,
  ReviewInternalFinanceDto,
  UpdateInternalFinanceCashIssuedDto,
  UpdateWarehouseReceiptDto,
  UpdateWarehouseExpenseDto,
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

  @Get('warehouse-receipts')
  @RequirePermissions('warehouse_cash:view')
  @ApiOperation({ summary: 'List warehouse cash receipts' })
  warehouseReceipts(@Query() query: InternalFinanceQueryDto) {
    return this.service.listWarehouseReceipts(query);
  }

  @Get('warehouse-receipts/:id')
  @RequirePermissions('warehouse_cash:view')
  @ApiOperation({ summary: 'Get one warehouse cash receipt' })
  warehouseReceipt(@Param('id', ParseIntPipe) id: number) {
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

  @Patch('warehouse-expenses/:id/mark-issued')
  @ApiOperation({ summary: 'Mark a warehouse expense as issued and post cash' })
  markWarehouseExpenseIssued(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MarkWarehouseExpenseIssuedDto,
    @CurrentUser() user: any,
  ) {
    return this.service.markWarehouseExpenseIssued(id, user, dto);
  }

  @Post('warehouse-receipts/lark-import')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({
    summary: 'Import warehouse cash history without Lark identifiers',
  })
  importWarehouseCash(
    @Body() dto: WarehouseCashImportDto,
    @CurrentUser() user: any,
  ) {
    return this.larkImport.importWarehouseCash(dto, user.id);
  }

  @Post('warehouse-receipts')
  @RequirePermissions('warehouse_cash:create')
  @ApiOperation({ summary: 'Create a manual warehouse cash receipt' })
  createWarehouseReceipt(
    @Body() dto: CreateWarehouseReceiptDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createWarehouseReceipt(dto, user.id);
  }

  @Patch('warehouse-receipts/:id')
  @RequirePermissions('warehouse_cash:update')
  @ApiOperation({ summary: 'Update an open warehouse cash receipt' })
  updateWarehouseReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWarehouseReceiptDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateWarehouseReceipt(id, dto, user.id);
  }

  @Post('warehouse-receipts/:id/post')
  @RequirePermissions('warehouse_cash:post')
  @ApiOperation({ summary: 'Allocate and create cash receipts' })
  postWarehouseReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PostWarehouseReceiptDto,
    @CurrentUser() user: any,
  ) {
    return this.service.postWarehouseReceipt(id, dto, user.id);
  }

  @Put('warehouse-receipts/:id/cancel')
  @RequirePermissions('warehouse_cash:cancel')
  @ApiOperation({ summary: 'Cancel a warehouse cash receipt' })
  cancelWarehouseReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelWarehouseReceiptDto,
    @CurrentUser() user: any,
  ) {
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

  @Post('lark-import')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({
    summary: 'Import historical Lark finance records without posting cash',
  })
  importFromLark(@Body() dto: LarkFinanceImportDto, @CurrentUser() user: any) {
    return this.larkImport.importHistory(dto, user.id);
  }

  @Post('vehicle-care')
  @ApiOperation({ summary: 'Create a vehicle care entry' })
  createVehicleCare(
    @Body() dto: CreateVehicleCareEntryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createVehicleCare(dto, user);
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
