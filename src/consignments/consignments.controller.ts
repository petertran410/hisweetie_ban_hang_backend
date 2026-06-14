import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConsignmentsService } from './consignments.service';
import {
  CreateConsignmentDto,
  UpdateConsignmentDto,
  ConsignmentQueryDto,
  CancelConsignmentDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Consignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('consignments')
export class ConsignmentsController {
  constructor(private consignmentsService: ConsignmentsService) {}

  @Get()
  @RequirePermissions('consignments:view')
  findAll(@Query() query: ConsignmentQueryDto, @CurrentUser() user: any) {
    return this.consignmentsService.findAll(query, user);
  }

  @Get('totals')
  @RequirePermissions('consignments:view')
  getTotals(@Query() query: ConsignmentQueryDto, @CurrentUser() user: any) {
    return this.consignmentsService.getTotals(query, user);
  }

  @Get('consignment-summary')
  @RequirePermissions('consignments:view')
  getConsignmentSummary(
    @Query('productIds') productIds?: string,
    @Query('branchId') branchId?: string,
  ) {
    const ids = (productIds || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);
    return this.consignmentsService.getConsignmentSummary(
      ids,
      branchId ? +branchId : undefined,
    );
  }

  @Get('consignment-by-product')
  @RequirePermissions('consignments:view')
  getConsignmentByProduct(
    @Query('productId') productId: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.consignmentsService.getConsignmentByProduct(
      +productId,
      branchId ? +branchId : undefined,
    );
  }

  @Get('for-packing')
  @RequirePermissions('consignments:view')
  findForPacking(
    @Query('branchId') branchId?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    return this.consignmentsService.findForPacking({
      branchId: branchId ? +branchId : undefined,
      pageSize: pageSize ? +pageSize : 100,
      search,
    });
  }

  @Put(':id/cancel')
  @RequirePermissions('consignments:update')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelConsignmentDto,
    @CurrentUser() user: any,
  ) {
    return this.consignmentsService.cancel(+id, dto, user.id);
  }

  @Get(':id')
  @RequirePermissions('consignments:view')
  findOne(@Param('id') id: string) {
    return this.consignmentsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('consignments:create')
  create(@Body() dto: CreateConsignmentDto, @CurrentUser() user: any) {
    return this.consignmentsService.create(dto, user.id);
  }

  @Put(':id')
  @RequirePermissions('consignments:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateConsignmentDto,
    @CurrentUser() user: any,
  ) {
    return this.consignmentsService.update(+id, dto, user.id);
  }
}
