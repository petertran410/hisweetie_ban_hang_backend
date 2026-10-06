import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApprovalLifecycleService } from './approval-lifecycle.service';
import { LinkApprovalCashFlowDto } from './dto/create-approval-request.dto';
import { ApprovalRequestQueryDto } from './dto/approval-request-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Approval Lifecycle')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('approval-requests')
export class ApprovalLifecycleController {
  constructor(private readonly service: ApprovalLifecycleService) {}

  @Post('upload-file')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Upload an Approval attachment' })
  uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body('type') type: string,
  ) {
    return this.service.uploadFile(file, type);
  }

  @Get()
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'List POS-linked Lark Approval requests' })
  findAll(@Query() query: ApprovalRequestQueryDto) {
    return this.service.findAll(query);
  }

  @Get('receipt-temp-advances')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'List approved outstanding temporary advances' })
  findTempAdvanceOptions(@Query('search') search?: string) {
    return this.service.findTempAdvanceOptions(search);
  }

  @Get(':id')
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'Get POS-linked Lark Approval request' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post(':id/link-cashflow')
  @RequirePermissions('cash_flows:update')
  @ApiOperation({
    summary: 'Link an approved Approval to an existing CashFlow',
  })
  linkCashFlow(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LinkApprovalCashFlowDto,
  ) {
    return this.service.linkCashFlow(id, dto.cashFlowId);
  }

  @Post(':id/post-cashflow')
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Confirm an approved expense as paid' })
  postCashFlow(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.service.postCashFlow(id, user.id);
  }
}
