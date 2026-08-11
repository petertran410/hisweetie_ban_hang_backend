import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentNoteDto } from './create-payment-note.dto';

@Injectable()
export class PaymentNotesService {
  constructor(private readonly prisma: PrismaService) {}

  private validate(dto: CreatePaymentNoteDto) {
    if (dto.paymentType === 'cash' && (dto.amount == null || dto.amount < 0)) {
      throw new BadRequestException('Số tiền tiền mặt là bắt buộc');
    }
  }

  async createOrderNote(
    orderId: number,
    dto: CreatePaymentNoteDto,
    userId: number,
  ) {
    this.validate(dto);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return this.prisma.orderPaymentNote.create({
      data: {
        orderId,
        paymentType: dto.paymentType,
        amount: dto.paymentType === 'cash' ? dto.amount : null,
        createdBy: userId,
      },
    });
  }

  async createInvoiceNote(
    invoiceId: number,
    dto: CreatePaymentNoteDto,
    userId: number,
  ) {
    this.validate(dto);
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
