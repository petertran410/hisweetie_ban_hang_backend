import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as PDFDocument from 'pdfkit';

@Injectable()
export class PdfService {
  constructor(private prisma: PrismaService) {}

  async generateOrderInvoice(orderId: number): Promise<Buffer> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        creator: true,
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!order) {
      throw new Error('Order not found');
    }

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text('HÓA ĐƠN BÁN HÀNG', { align: 'center' });
      doc.moveDown();

      doc.fontSize(12);
      doc.text(`Mã đơn hàng: ${order.code}`, 50, 150);
      doc.text(
        `Ngày bán: ${order.orderDate.toLocaleDateString('vi-VN')}`,
        50,
        170,
      );

      doc.text(`Người bán: ${order.creator?.name || 'N/A'}`, 50, 190);

      doc.text(
        `Khách hàng: ${order.customer?.name || 'Khách vãng lai'}`,
        350,
        150,
      );
      if (order.customer?.phone) {
        doc.text(`Số điện thoại: ${order.customer.phone}`, 350, 170);
      }

      let y = 250;
      doc
        .fontSize(10)
        .text('STT', 50, y)
        .text('Sản phẩm', 100, y)
        .text('SL', 350, y)
        .text('Đơn giá', 400, y)
        .text('Thành tiền', 480, y);

      y += 20;
      doc.moveTo(50, y).lineTo(550, y).stroke();

      y += 10;
      order.items.forEach((item, index) => {
        doc.text((index + 1).toString(), 50, y);
        doc.text(item.product.name, 100, y, { width: 230 });
        doc.text(item.quantity.toString(), 350, y);
        doc.text(this.formatCurrency(item.unitPrice), 400, y);
        doc.text(this.formatCurrency(item.totalPrice), 480, y);
        y += 30;
      });

      y += 20;
      doc.text('Tổng tiền:', 350, y);
      doc.text(this.formatCurrency(order.totalAmount), 480, y);

      y += 20;
      doc.text('Giảm giá:', 350, y);
      doc.text(this.formatCurrency(order.discountAmount), 480, y);

      y += 20;
      doc.text('Thành tiền:', 350, y);
      doc.text(this.formatCurrency(order.grandTotal), 480, y);

      y += 20;
      doc.text('Đã thanh toán:', 350, y);
      doc.text(this.formatCurrency(order.paidAmount), 480, y);

      y += 20;
      doc.text('Còn nợ:', 350, y);
      doc.text(this.formatCurrency(order.debtAmount), 480, y);

      doc.end();
    });
  }

  private formatCurrency(amount: number): string {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  }
}
