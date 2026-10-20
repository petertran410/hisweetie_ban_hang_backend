import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  CashAdvancesService,
  type CashAdvanceActor,
} from './cash-advances.service';
import { CashAdvanceRefundsService } from './cash-advance-refunds.service';
import {
  CashAdvanceQueryDto,
  CashAdvanceReasonDto,
  CashAdvanceRefundQueryDto,
  CreateCashAdvanceDto,
  CreateCashAdvanceRefundDto,
  FundBalanceQueryDto,
  RecipientStatusQueryDto,
  SignedVoucherDto,
  UpdateCashAdvanceDto,
  UpdateCashAdvanceRefundDto,
} from './dto/cash-advance.dto';

@ApiTags('Cash Advances')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cash-advances')
export class CashAdvancesController {
  constructor(
    private readonly service: CashAdvancesService,
    private readonly refunds: CashAdvanceRefundsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Danh sách phiếu tạm ứng kèm đối chiếu phiếu chi kho',
  })
  list(
    @Query() query: CashAdvanceQueryDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.list(query, user);
  }

  // Các route cố định khai báo trước `:id`.
  @Get('recipient-status')
  recipientStatus(
    @Query() query: RecipientStatusQueryDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.recipientStatus(query, user);
  }

  @Get('fund-balance')
  fundBalance(
    @Query() query: FundBalanceQueryDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.fundBalance(query, user);
  }

  @Get('refundable-advances')
  refundableAdvances(
    @Query('branchId') branchId: string | undefined,
    @Query('search') search: string | undefined,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.refunds.refundableAdvances(
      { branchId: branchId ? Number(branchId) : undefined, search },
      user,
    );
  }

  @Get('coverage/:entryId')
  @ApiOperation({ summary: 'Xem trước phần phiếu chi kho chi từ tạm ứng' })
  coverage(
    @Param('entryId', ParseIntPipe) entryId: number,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.coveragePreview(entryId, user);
  }

  @Post('entries/:entryId/release')
  @ApiOperation({ summary: 'Bỏ Đã chi của phiếu chi kho đã chi từ tạm ứng' })
  releaseEntry(
    @Param('entryId', ParseIntPipe) entryId: number,
    @Body() dto: CashAdvanceReasonDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.releaseEntry(entryId, dto, user);
  }

  @Get(':id')
  get(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.get(id, user);
  }

  @Get(':id/refundable')
  refundable(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.refundable(id, user);
  }

  @Post()
  create(
    @Body() dto: CreateCashAdvanceDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCashAdvanceDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.update(id, dto, user);
  }

  @Post(':id/confirm')
  @ApiOperation({ summary: 'Xác nhận giao tiền (ghi chi quỹ kho)' })
  confirm(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.confirm(id, user);
  }

  @Post(':id/signed')
  @ApiOperation({ summary: 'Upload phiếu tạm ứng đã ký → Hoàn thành' })
  uploadSigned(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SignedVoucherDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.uploadSigned(id, dto, user);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CashAdvanceReasonDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.cancel(id, dto, user);
  }
}

@ApiTags('Cash Advance Refunds')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cash-advance-refunds')
export class CashAdvanceRefundsController {
  constructor(private readonly service: CashAdvanceRefundsService) {}

  @Get()
  list(
    @Query() query: CashAdvanceRefundQueryDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.list(query, user);
  }

  @Get(':id')
  get(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.get(id, user);
  }

  @Post()
  create(
    @Body() dto: CreateCashAdvanceRefundDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCashAdvanceRefundDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.update(id, dto, user);
  }

  @Post(':id/confirm')
  @ApiOperation({ summary: 'Xác nhận nhận tiền hoàn ứng (ghi thu quỹ kho)' })
  confirm(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.confirm(id, user);
  }

  @Post(':id/signed')
  uploadSigned(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SignedVoucherDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.uploadSigned(id, dto, user);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CashAdvanceReasonDto,
    @CurrentUser() user: CashAdvanceActor,
  ) {
    return this.service.cancel(id, dto, user);
  }
}
