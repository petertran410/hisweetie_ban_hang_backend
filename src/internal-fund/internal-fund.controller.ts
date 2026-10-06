import {
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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { InternalFundService } from './internal-fund.service';
import type { InternalFundActor } from './internal-fund.constants';
import {
  CancelInternalFundTransferDto,
  CloseInternalFundDayDto,
  CreateInternalFundReceiptApprovalDto,
  InternalFundQueryDto,
  MarkInternalFundExpenseDto,
  UpdateInternalFundTransactionDto,
} from './dto/internal-fund.dto';

@ApiTags('Internal Fund')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('internal-fund')
export class InternalFundController {
  constructor(private readonly service: InternalFundService) {}

  @Get('access')
  access(@CurrentUser() user: InternalFundActor) {
    return this.service.access(user);
  }

  @Post('upload-file')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  uploadFile(
    @Body('branchId', ParseIntPipe) branchId: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.uploadFile(branchId, file, user.id);
  }

  @Get('approvals')
  approvals(
    @Query() query: InternalFundQueryDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.listApprovals(query, user);
  }

  @Get('approvals/:id')
  approval(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.getApproval(id, user);
  }

  @Get('transfers')
  transfers(
    @Query() query: InternalFundQueryDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.listTransfers(query, user);
  }

  @Post('transfers')
  createTransfer(
    @Body() dto: CreateInternalFundReceiptApprovalDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.createReceiptApproval(
      { ...dto, classification: 'INTERNAL_TRANSFER' },
      user.id,
    );
  }

  @Post('transactions')
  createReceipt(
    @Body() dto: CreateInternalFundReceiptApprovalDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.createReceiptApproval(dto, user.id);
  }

  @Patch('transactions/:id')
  updateTransaction(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInternalFundTransactionDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.updateTransaction(id, dto, user.id);
  }

  @Put('transactions/:id/cancel')
  cancelTransaction(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelInternalFundTransferDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.cancelTransaction(id, dto, user.id);
  }

  @Post('transactions/:id/post')
  postTransaction(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.postTransaction(id, user.id);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'List internal fund transactions' })
  listTransactions(
    @Query() query: InternalFundQueryDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.listTransactions(query, user);
  }

  @Get('summary')
  summary(
    @Query() query: InternalFundQueryDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.summary(query, user);
  }

  @Post('entries/:id/post')
  @ApiOperation({ summary: 'Post an approved expense to internal fund' })
  postExpense(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MarkInternalFundExpenseDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.postExpenseEntry(id, user.id, dto.issued);
  }

  @Post('approvals/receipts')
  @ApiOperation({ summary: 'Create a Lark receipt approval' })
  createReceiptApproval(
    @Body() dto: CreateInternalFundReceiptApprovalDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.createReceiptApproval(dto, user.id);
  }

  @Post('approvals/:id/post')
  @ApiOperation({
    summary: 'Post an approved receipt approval to internal fund',
  })
  postApproval(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.postApprovedApproval(id, user.id);
  }

  @Get('daily-closings')
  @ApiOperation({ summary: 'List internal fund daily closings' })
  listDailyClosings(
    @Query() query: InternalFundQueryDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.listDailyClosings(query, user);
  }

  @Get('daily-closings/:id')
  dailyClosing(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.getDailyClosing(id, user);
  }

  @Post('daily-closings')
  @ApiOperation({ summary: 'Close an internal fund day' })
  closeDay(
    @Body() dto: CloseInternalFundDayDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.closeDay(dto, user.id);
  }

  @Put('transfers/:id/cancel')
  @ApiOperation({ summary: 'Cancel an internal fund transfer' })
  cancelTransfer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelInternalFundTransferDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.cancelTransfer(id, dto, user.id);
  }
}

@ApiTags('Internal Fund Approval')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('approval-requests')
export class InternalFundApprovalController {
  constructor(private readonly service: InternalFundService) {}

  @Post()
  create(
    @Body() dto: CreateInternalFundReceiptApprovalDto,
    @CurrentUser() user: InternalFundActor,
  ) {
    return this.service.createReceiptApproval(dto, user.id);
  }
}
