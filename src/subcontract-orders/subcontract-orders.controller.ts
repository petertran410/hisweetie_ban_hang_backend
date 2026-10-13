import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';
import { requestHasPermission } from '../auth/request-permissions';
import { SubcontractOrdersService } from './subcontract-orders.service';
import { SubcontractOrderCostingService } from './subcontract-order-costing.service';
import { SubcontractOrderPaymentsService } from './subcontract-order-payments.service';
import {
  ApplyCostDto,
  AtFactoryQueryDto,
  CancelSubcontractOrderDto,
  CompleteSubcontractOrderDto,
  CreateReceiptDto,
  CreateSubcontractOrderDto,
  CreateSubcontractPaymentDto,
  MaterialSuggestionQueryDto,
  SendMaterialsDto,
  SubcontractCostDto,
  SubcontractOrderQueryDto,
  UpdateSubcontractOrderDto,
} from './dto';

const VIEW_COST = 'subcontract_orders:view_cost_price';

@ApiTags('SubcontractOrders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('subcontract-orders')
export class SubcontractOrdersController {
  constructor(
    private ordersService: SubcontractOrdersService,
    private costingService: SubcontractOrderCostingService,
    private paymentsService: SubcontractOrderPaymentsService,
  ) {}

  @Get()
  @RequirePermissions('subcontract_orders:view')
  findAll(@Query() query: SubcontractOrderQueryDto, @Req() req: any) {
    return this.ordersService.findAll(
      query,
      requestHasPermission(req, VIEW_COST),
    );
  }

  @Get('material-suggestions')
  @RequirePermissions('subcontract_orders:view')
  materialSuggestions(
    @Query() query: MaterialSuggestionQueryDto,
    @Req() req: any,
  ) {
    return this.ordersService
      .getMaterialSuggestions(query)
      .then((rows) =>
        requestHasPermission(req, VIEW_COST)
          ? rows
          : rows.map((r) => ({ ...r, unitCost: null })),
      );
  }

  @Get('at-factory')
  @RequirePermissions('subcontract_orders:view')
  atFactory(@Query() query: AtFactoryQueryDto, @Req() req: any) {
    return this.ordersService.getMaterialsAtFactory(
      query,
      requestHasPermission(req, VIEW_COST),
    );
  }

  @Get(':id')
  @RequirePermissions('subcontract_orders:view')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.ordersService.findOne(id, requestHasPermission(req, VIEW_COST));
  }

  @Post()
  @RequirePermissions('subcontract_orders:create')
  create(@Body() dto: CreateSubcontractOrderDto, @Req() req: any) {
    return this.ordersService.create(dto, req.user.id);
  }

  @Put(':id')
  @RequirePermissions('subcontract_orders:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSubcontractOrderDto,
    @Req() req: any,
  ) {
    return this.ordersService.update(id, dto, req.user.id);
  }

  @Post(':id/send')
  @RequirePermissions('subcontract_orders:update')
  send(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SendMaterialsDto,
    @Req() req: any,
  ) {
    return this.ordersService.sendMaterials(id, dto, req.user.id);
  }

  @Post(':id/receipts')
  @RequirePermissions('subcontract_orders:receive')
  createReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateReceiptDto,
    @Req() req: any,
  ) {
    return this.ordersService.createReceipt(id, dto, req.user.id);
  }

  @Post(':id/receipts/:receiptId/cancel')
  @RequirePermissions('subcontract_orders:receive')
  cancelReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Param('receiptId', ParseIntPipe) receiptId: number,
    @Req() req: any,
  ) {
    return this.ordersService.cancelReceipt(id, receiptId, req.user.id);
  }

  @Post(':id/costs')
  @RequirePermissions('subcontract_orders:update')
  addCost(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubcontractCostDto,
  ) {
    return this.ordersService.addCost(id, dto);
  }

  @Put(':id/costs/:costId')
  @RequirePermissions('subcontract_orders:update')
  updateCost(
    @Param('id', ParseIntPipe) id: number,
    @Param('costId', ParseIntPipe) costId: number,
    @Body() dto: SubcontractCostDto,
  ) {
    return this.ordersService.updateCost(id, costId, dto);
  }

  @Delete(':id/costs/:costId')
  @RequirePermissions('subcontract_orders:update')
  removeCost(
    @Param('id', ParseIntPipe) id: number,
    @Param('costId', ParseIntPipe) costId: number,
  ) {
    return this.ordersService.removeCost(id, costId);
  }

  @Post(':id/complete')
  @RequirePermissions('subcontract_orders:complete')
  complete(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CompleteSubcontractOrderDto,
    @Req() req: any,
  ) {
    return this.ordersService.complete(id, dto, req.user.id);
  }

  @Post(':id/cancel')
  @RequirePermissions('subcontract_orders:cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelSubcontractOrderDto,
    @Req() req: any,
  ) {
    return this.ordersService.cancel(id, dto, req.user.id);
  }

  @Get(':id/cost-preview')
  @RequirePermissions('subcontract_orders:view_cost_price')
  costPreview(@Param('id', ParseIntPipe) id: number) {
    return this.costingService.preview(id);
  }

  @Post(':id/apply-cost')
  @RequirePermissions('subcontract_orders:apply_cost')
  applyCost(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApplyCostDto,
    @Req() req: any,
  ) {
    return this.costingService.apply(id, dto, req.user.id);
  }

  @Post(':id/payments')
  @RequirePermissions('subcontract_orders:payment')
  createPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateSubcontractPaymentDto,
    @Req() req: any,
  ) {
    return this.paymentsService.create(id, dto, req.user.id);
  }

  @Delete(':id/payments/:paymentId')
  @RequirePermissions('subcontract_orders:payment')
  removePayment(
    @Param('id', ParseIntPipe) id: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Req() req: any,
  ) {
    return this.paymentsService.remove(id, paymentId, req.user.id);
  }
}
