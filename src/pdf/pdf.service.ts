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
        items: {
          include: {
            product: {
              include: {
                variant: true,
              },
            },
          },
        },
        creator: true,
      },
    });

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // Header
      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .text('HÓA ĐƠN BÁN HÀNG', { align: 'center' });

      doc.moveDown();

      // Order info
      doc.fontSize(10).font('Helvetica');
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

      // Items table
      const tableTop = 250;
      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .text('STT', 50, tableTop)
        .text('Sản phẩm', 100, tableTop)
        .text('ĐVT', 300, tableTop)
        .text('SL', 350, tableTop)
        .text('Đơn giá', 400, tableTop)
        .text('Thành tiền', 480, tableTop);

      doc
        .moveTo(50, tableTop + 15)
        .lineTo(550, tableTop + 15)
        .stroke();

      let y = tableTop + 25;
      doc.font('Helvetica');

      order.items.forEach((item, index) => {
        doc.text((index + 1).toString(), 50, y);
        doc.text(item.product.name, 100, y, { width: 180 });
        doc.text(item.product.variant?.name || '-', 300, y);
        doc.text(item.quantity.toString(), 350, y);
        doc.text(this.formatCurrency(item.unitPrice), 400, y);
        doc.text(this.formatCurrency(item.totalPrice), 480, y);
        y += 25;
      });

      // Totals
      y += 20;
      doc.moveTo(50, y).lineTo(550, y).stroke();

      y += 20;
      doc.font('Helvetica-Bold');
      doc.text('Tổng tiền:', 400, y);
      doc.text(this.formatCurrency(order.totalAmount), 480, y);

      y += 20;
      doc.text('Giảm giá:', 400, y);
      doc.text(this.formatCurrency(order.discountAmount), 480, y);

      y += 20;
      doc.text('Thành tiền:', 400, y);
      doc.text(this.formatCurrency(order.grandTotal), 480, y);

      y += 20;
      doc.text('Đã thanh toán:', 400, y);
      doc.text(this.formatCurrency(order.paidAmount), 480, y);

      y += 20;
      doc.text('Còn nợ:', 400, y);
      doc.text(this.formatCurrency(order.debtAmount), 480, y);

      // Footer
      doc
        .fontSize(9)
        .font('Helvetica')
        .text('Cảm ơn quý khách!', 50, 700, { align: 'center' });

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
