import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { CreatePaymentNoteDto } from './create-payment-note.dto';

/** Nhãn hiển thị trong log: "CK", "TM (500.000 đ)", "Chưa chọn". */
function paymentNoteLabel(
  paymentType: string | null | undefined,
  amount: unknown,
): string {
  if (!paymentType) return 'Chưa chọn';
  if (paymentType === 'cash') {
    return `TM (${Math.round(Number(amount || 0)).toLocaleString('vi-VN')} đ)`;
  }
  return 'CK';
}

type PendingAuditLog = Parameters<AuditLogsService['create']>[0];

function validatePaymentNote(dto: CreatePaymentNoteDto) {
  if (dto.paymentType === 'cash' && (dto.amount == null || dto.amount < 0)) {
    throw new BadRequestException('Số tiền tiền mặt là bắt buộc');
  }
}

/**
 * Thêm 1 dòng ghi chú phương thức thanh toán cho đơn trong transaction `tx`
 * của caller (hoặc PrismaService). Trả về audit log (khi đổi phương thức/số
 * tiền mặt) để caller ghi SAU KHI commit.
 * Dùng chung cho POST /orders/:id/payment-note và lưu đơn ở Bán hàng
 * (PUT /orders/:id), nơi ghi chú phải có trước bước kiểm tra công nợ.
 */
export async function createOrderPaymentNoteInTx(
  tx: Prisma.TransactionClient,
  orderId: number,
  dto: CreatePaymentNoteDto,
  userId: number,
  userName?: string,
) {
  validatePaymentNote(dto);
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      code: true,
      branchId: true,
      paymentNotes: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { paymentType: true, amount: true },
      },
    },
  });
  if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
  const note = await tx.orderPaymentNote.create({
    data: {
      orderId,
      paymentType: dto.paymentType,
      amount: dto.paymentType === 'cash' ? dto.amount : null,
      createdBy: userId,
    },
  });

  // Mỗi lần lưu đơn ở Bán hàng đều thêm 1 dòng; chỉ ghi log khi đổi
  // phương thức hoặc số tiền mặt để log hệ thống tra lại được.
  const previous = order.paymentNotes[0];
  const from = paymentNoteLabel(previous?.paymentType, previous?.amount);
  const to = paymentNoteLabel(note.paymentType, note.amount);
  if (from === to) return { note, auditLog: null };

  const auditLog: PendingAuditLog = {
    actionType: 'POST',
    actionCode: 'ORDER_PAYMENT_NOTE_CHANGE',
    entityType: 'orders',
    entityId: String(orderId),
    entityCode: order.code,
    category: getCategoryFromActionCode('ORDER_PAYMENT_NOTE_CHANGE'),
    severity: getSeverityFromActionCode('ORDER_PAYMENT_NOTE_CHANGE'),
    changes: [
      {
        type: 'field_changed',
        field: 'paymentNoteType',
        label: 'Phương thức thanh toán',
        from,
        to,
      },
    ],
    message: renderAuditMessage('ORDER_PAYMENT_NOTE_CHANGE', {
      orderCode: order.code,
      from,
      to,
    }),
    messageTemplate: 'ORDER_PAYMENT_NOTE_CHANGE',
    userId,
    userName: userName || `User #${userId}`,
    branchId: order.branchId ?? undefined,
  };
  return { note, auditLog };
}

@Injectable()
export class PaymentNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  async createOrderNote(
    orderId: number,
    dto: CreatePaymentNoteDto,
    userId: number,
    userName?: string,
  ) {
    const { note, auditLog } = await createOrderPaymentNoteInTx(
      this.prisma,
      orderId,
      dto,
      userId,
      userName,
    );
    if (auditLog) void this.auditLogsService.create(auditLog);
    return note;
  }

  async createInvoiceNote(
    invoiceId: number,
    dto: CreatePaymentNoteDto,
    userId: number,
  ) {
    validatePaymentNote(dto);
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true },
    });
    if (!invoice) throw new NotFoundException('Không tìm thấy hóa đơn');
    return this.prisma.invoicePaymentNote.create({
      data: {
        invoiceId,
        paymentType: dto.paymentType,
        amount: dto.paymentType === 'cash' ? dto.amount : null,
        createdBy: userId,
      },
    });
  }
}
