import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
  Res,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { DebtTrackingService } from './debt-tracking.service';
import { DebtPolicyImportService } from './debt-policy-import.service';
import {
  DebtTrackingQueryDto,
  UpsertDebtPolicyDto,
  UpdateDebtNoteDto,
  UpdatePaymentHistoryOverrideDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  RequirePermissions,
  RequireAnyPermission,
} from '../auth/decorators/permissions.decorator';
import { AuthService } from '../auth/auth.service';
import {
  DEBT_STATUS_LABELS,
  DEBT_FORM_LABELS,
} from './debt-tracking.constants';
import * as ExcelJS from 'exceljs';

const PERM_NOTE_ACCOUNTANT = 'debt_tracking:note_accountant';
const PERM_NOTE_SALE = 'debt_tracking:note_sale';
const SUPER_ADMIN_ROLE = 'Super Admin';

@ApiTags('DebtTracking')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('debt-tracking')
export class DebtTrackingController {
  /** Giới hạn kích thước file upload. */
  private static readonly UPLOAD_OPTIONS = {
    limits: { fileSize: 10 * 1024 * 1024 },
  };

  constructor(
    private debtTrackingService: DebtTrackingService,
    private importService: DebtPolicyImportService,
    private authService: AuthService,
  ) {}

  private assertExcel(file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Chưa chọn file');
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Chỉ chấp nhận file Excel (.xlsx)');
    }
  }

  @Get()
  @RequirePermissions('debt_tracking:view')
  @ApiOperation({ summary: 'Danh sách theo dõi công nợ khách hàng' })
  findAll(@Query() query: DebtTrackingQueryDto) {
    return this.debtTrackingService.findAll(query);
  }

  @Get('summary')
  @RequirePermissions('debt_tracking:view')
  @ApiOperation({ summary: 'Số liệu tổng hợp công nợ' })
  getSummary(@Query() query: DebtTrackingQueryDto) {
    return this.debtTrackingService.getSummary(query);
  }

  @Get('export')
  @RequirePermissions('debt_tracking:export')
  @ApiOperation({ summary: 'Xuất Excel danh sách theo dõi công nợ' })
  async exportExcel(
    @Query() query: DebtTrackingQueryDto,
    @Res() res: Response,
  ) {
    const rows = await this.debtTrackingService.findAllForExport(query);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Theo dõi công nợ');

    ws.columns = [
      { header: 'Mã Khách Hàng', key: 'code', width: 16 },
      { header: 'Tên Khách Hàng', key: 'name', width: 34 },
      { header: 'Điện Thoại', key: 'phone', width: 14 },
      { header: 'Chi Nhánh', key: 'branch', width: 18 },
      { header: 'Hình Thức Công Nợ', key: 'debtForm', width: 22 },
      { header: 'Loại Công Nợ', key: 'policy', width: 24 },
      { header: 'Hạn Mức Công Nợ', key: 'creditLimit', width: 18 },
      { header: 'Nợ Hiện Tại', key: 'totalDebt', width: 18 },
      { header: 'Vượt Hạn Mức', key: 'overLimit', width: 18 },
      { header: '% Vượt Hạn Mức', key: 'overLimitPct', width: 15 },
      { header: 'Nợ Quá Hạn', key: 'overdue', width: 18 },
      { header: 'Số Ngày Quá Hạn', key: 'daysOverdue', width: 15 },
      { header: 'Hạn Gần Nhất', key: 'dueDate', width: 14 },
      { header: 'Ngày Thanh Toán Gần Nhất', key: 'lastPayDate', width: 20 },
      { header: 'Số Tiền TT Gần Nhất', key: 'lastPayAmount', width: 18 },
      { header: 'Trạng Thái Nợ', key: 'debtStatus', width: 14 },
      { header: 'Sale PIC', key: 'salePic', width: 18 },
      { header: 'Kế Toán Công Nợ PIC', key: 'accountantPic', width: 20 },
      { header: 'Phiếu Thu Hồi', key: 'ticket', width: 16 },
      {
        header: 'Ghi Chú Của Kế Toán Công Nợ',
        key: 'accountantNote',
        width: 32,
      },
      { header: 'Ghi Chú Của Sale', key: 'saleNote', width: 32 },
    ];
    ws.getRow(1).font = { bold: true };

    const fmtDate = (d: any) =>
      d ? new Date(d).toLocaleDateString('vi-VN') : '';

    // Mô tả loại công nợ theo hai chiều đang bật.
    const describePolicy = (p: any): string => {
      if (!p) return '';
      const parts: string[] = [];
      if (p.hasCreditLimit) parts.push('Hạn Mức');
      if (p.hasTermDays && p.termDays != null) {
        parts.push(`Công Nợ ${p.termDays} Ngày`);
      }
      if (p.paymentFrequency) parts.push(`1 Tháng ${p.paymentFrequency} Lần`);
      return parts.length ? parts.join(', ') : 'Không Công Nợ';
    };

    for (const r of rows as any[]) {
      ws.addRow({
        code: r.code,
        name: r.name,
        phone: r.contactNumber,
        branch: r.branch?.name ?? '',
        debtForm: DEBT_FORM_LABELS[r.policy?.debtForm] ?? '',
        policy: describePolicy(r.policy),
        creditLimit: r.creditLimit ?? '',
        totalDebt: r.totalDebt,
        overLimit: r.overLimitAmount || '',
        overLimitPct: r.creditUsageRatio
          ? `${Math.round(r.creditUsageRatio * 100)}%`
          : '',
        overdue: r.overdueAmount || '',
        daysOverdue: r.maxDaysOverdue || '',
        dueDate: fmtDate(r.nearestDueDate),
        lastPayDate: fmtDate(r.lastPayment?.transDate),
        lastPayAmount: r.lastPayment?.amount ?? '',
        debtStatus: DEBT_STATUS_LABELS[r.debtStatus] ?? r.debtStatus,
        salePic: r.policy?.salePic?.name ?? '',
        accountantPic: r.policy?.accountantPic?.name ?? '',
        ticket: r.openTicket?.ticketCode ?? '',
        accountantNote: r.accountantNote ?? '',
        saleNote: r.saleNote ?? '',
      });
    }

    [
      'totalDebt',
      'overdue',
      'creditLimit',
      'lastPayAmount',
      'overLimit',
    ].forEach((k) => {
      ws.getColumn(k).numFmt = '#,##0';
    });

    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate(),
    )}_${pad(now.getHours())}${pad(now.getMinutes())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="theo-doi-cong-no_${stamp}.xlsx"`,
    );

    const buffer = await wb.xlsx.writeBuffer();
    res.end(Buffer.from(buffer));
  }

  // ================================================================
  // IMPORT THIẾT LẬP CÔNG NỢ TỪ EXCEL
  // Đặt trước các route có tham số động để không bị nuốt route.
  // ================================================================

  @Get('import/template')
  @RequirePermissions('debt_tracking:update_policy')
  @ApiOperation({
    summary: 'Tải file Excel mẫu để thiết lập công nợ hàng loạt',
  })
  async downloadTemplate(@Res() res: Response) {
    const buffer = await this.importService.template();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="mau-thiet-lap-cong-no.xlsx"',
    );
    res.send(buffer);
  }

  /** Bước 1: chỉ đọc file và đối chiếu DB, KHÔNG ghi gì. */
  @Post('import/preview')
  @RequirePermissions('debt_tracking:update_policy')
  @UseInterceptors(
    FileInterceptor('file', DebtTrackingController.UPLOAD_OPTIONS),
  )
  @ApiOperation({ summary: 'Kiểm tra file trước khi import (không ghi DB)' })
  previewImport(@UploadedFile() file: Express.Multer.File) {
    this.assertExcel(file);
    return this.importService.preview(file);
  }

  /** Bước 2: ghi DB. Từ chối toàn bộ nếu còn dòng lỗi. */
  @Post('import')
  @RequirePermissions('debt_tracking:update_policy')
  @UseInterceptors(
    FileInterceptor('file', DebtTrackingController.UPLOAD_OPTIONS),
  )
  @ApiOperation({ summary: 'Import thiết lập công nợ hàng loạt' })
  commitImport(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    this.assertExcel(file);
    return this.importService.commit(file, req.user?.id || 1);
  }

  @Get('policy/:customerId')
  @RequirePermissions('debt_tracking:view')
  @ApiOperation({ summary: 'Xem chính sách công nợ của khách' })
  getPolicy(@Param('customerId') customerId: string) {
    return this.debtTrackingService.getPolicy(+customerId);
  }

  @Put('policy/:customerId')
  @RequirePermissions('debt_tracking:update_policy')
  @ApiOperation({ summary: 'Cập nhật chính sách công nợ của khách' })
  upsertPolicy(
    @Param('customerId') customerId: string,
    @Body() dto: UpsertDebtPolicyDto,
    @Req() req: any,
  ) {
    return this.debtTrackingService.upsertPolicy(
      +customerId,
      dto,
      req.user?.id,
    );
  }

  /**
   * Ghi chú kế toán và ghi chú sale là HAI cột độc lập với hai quyền riêng.
   * Guard chỉ kiểm tra "có ít nhất một trong hai quyền"; việc cột nào được
   * phép ghi do service quyết định dựa trên `allowed` bên dưới. Nhờ vậy một
   * người chỉ có quyền sale không thể ghi đè ghi chú của kế toán.
   */
  @Patch('payment-history/:customerId')
  @RequirePermissions('debt_tracking:update_policy')
  @ApiOperation({
    summary: 'Ghi đè đánh giá lịch sử thanh toán tự động (bắt buộc nêu lý do)',
  })
  updatePaymentHistory(
    @Param('customerId') customerId: string,
    @Body() dto: UpdatePaymentHistoryOverrideDto,
    @Req() req: any,
  ) {
    return this.debtTrackingService.updatePaymentHistoryOverride(
      +customerId,
      dto.paymentHistoryOverride,
      dto.reason,
      req.user?.id,
    );
  }

  @Patch('note/:customerId')
  @RequireAnyPermission(PERM_NOTE_ACCOUNTANT, PERM_NOTE_SALE)
  @ApiOperation({ summary: 'Cập nhật ghi chú kế toán / sale' })
  async updateNote(
    @Param('customerId') customerId: string,
    @Body() dto: UpdateDebtNoteDto,
    @Req() req: any,
  ) {
    const allowed = await this.resolveNotePermissions(req);

    if (dto.accountantNote !== undefined && !allowed.accountant) {
      throw new ForbiddenException('Bạn không có quyền ghi chú kế toán');
    }
    if (dto.saleNote !== undefined && !allowed.sale) {
      throw new ForbiddenException('Bạn không có quyền ghi chú sale');
    }

    return this.debtTrackingService.updateNote(
      +customerId,
      dto,
      req.user?.id,
      allowed,
    );
  }

  @Get(':customerId/detail')
  @RequirePermissions('debt_tracking:view')
  @ApiOperation({ summary: 'Chi tiết công nợ một khách hàng' })
  getDetail(@Param('customerId') customerId: string) {
    return this.debtTrackingService.getDetail(+customerId);
  }

  @Get(':customerId/suggested-minimum')
  @RequirePermissions('debt_tracking:view')
  @ApiOperation({
    summary:
      'Gợi ý số tiền tối thiểu cần thu (phần nợ đã đến hạn) khi tạo phiếu',
  })
  async getSuggestedMinimum(@Param('customerId') customerId: string) {
    const amount =
      await this.debtTrackingService.getSuggestedMinimumPayment(+customerId);
    return { customerId: +customerId, suggestedMinimumPayment: amount };
  }

  /**
   * Resolve quyền ghi chú theo đúng cách PermissionsGuard làm: ưu tiên quyền
   * theo chi nhánh (header X-Branch-Id) rồi mới tới quyền toàn cục.
   */
  private async resolveNotePermissions(req: any) {
    if (req.user?.roles?.includes(SUPER_ADMIN_ROLE)) {
      return { accountant: true, sale: true };
    }

    const raw =
      req.headers['x-branch-id'] || req.body?.branchId || req.query?.branchId;
    const branchId = raw ? parseInt(String(raw)) : undefined;

    let permissions: string[] = req.user?.permissions || [];
    if (branchId && !isNaN(branchId)) {
      permissions = await this.authService.getPermissionsForBranch(
        req.user.id,
        branchId,
      );
    }

    return {
      accountant: permissions.includes(PERM_NOTE_ACCOUNTANT),
      sale: permissions.includes(PERM_NOTE_SALE),
    };
  }
}
