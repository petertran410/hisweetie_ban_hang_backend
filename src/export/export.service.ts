import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';

@Injectable()
export class ExportService {
  constructor(private prisma: PrismaService) {}

  async exportProducts(): Promise<ExcelJS.Buffer> {
    const products = await this.prisma.product.findMany({
      include: {
        category: true,
        variant: true,
      },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Products');

    worksheet.columns = [
      { header: 'Mã SP', key: 'code', width: 15 },
      { header: 'Tên sản phẩm', key: 'name', width: 30 },
      { header: 'Danh mục', key: 'category', width: 20 },
      { header: 'Đơn vị', key: 'variant', width: 15 },
      { header: 'Giá nhập', key: 'purchasePrice', width: 15 },
      { header: 'Giá bán', key: 'retailPrice', width: 15 },
      { header: 'Tồn kho', key: 'stock', width: 12 },
      { header: 'Trạng thái', key: 'status', width: 12 },
    ];

    products.forEach((product) => {
      worksheet.addRow({
        code: product.code,
        name: product.name,
        category: product.category?.name || '',
        variant: product.variant?.name || '',
        purchasePrice: Number(product.purchasePrice),
        retailPrice: Number(product.retailPrice),
        stock: product.stockQuantity,
        status: product.isActive ? 'Đang bán' : 'Ngừng bán',
      });
    });

    return await workbook.xlsx.writeBuffer();
  }

  async exportOrders(dateFrom: Date, dateTo: Date): Promise<ExcelJS.Buffer> {
    const orders = await this.prisma.order.findMany({
      where: {
        orderDate: {
          gte: dateFrom,
          lte: dateTo,
        },
      },
      include: {
        customer: true,
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Orders');

    worksheet.columns = [
      { header: 'Mã đơn', key: 'code', width: 20 },
      { header: 'Ngày bán', key: 'orderDate', width: 15 },
      { header: 'Khách hàng', key: 'customer', width: 25 },
      { header: 'Tổng tiền', key: 'total', width: 15 },
      { header: 'Giảm giá', key: 'discount', width: 15 },
      { header: 'Thành tiền', key: 'grand', width: 15 },
      { header: 'Đã thanh toán', key: 'paid', width: 15 },
      { header: 'Còn nợ', key: 'debt', width: 15 },
      { header: 'Trạng thái', key: 'status', width: 15 },
    ];

    orders.forEach((order) => {
      worksheet.addRow({
        code: order.code,
        orderDate: order.orderDate,
        customer: order.customer?.name || 'Khách vãng lai',
        total: Number(order.totalAmount),
        discount: Number(order.discount),
        grand: Number(order.grandTotal),
        paid: Number(order.paidAmount),
        debt: Number(order.debtAmount),
        status: this.getOrderStatus(order.orderStatus),
      });
    });

    return await workbook.xlsx.writeBuffer();
  }

  async exportCustomers(): Promise<ExcelJS.Buffer> {
    const customers = await this.prisma.customer.findMany({
      include: {
        customerType: true,
      },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Customers');

    worksheet.columns = [
      { header: 'Mã KH', key: 'code', width: 15 },
      { header: 'Tên khách hàng', key: 'name', width: 30 },
      { header: 'Điện thoại', key: 'phone', width: 15 },
      { header: 'Loại KH', key: 'type', width: 15 },
      { header: 'Tổng mua', key: 'totalPurchased', width: 15 },
      { header: 'Công nợ', key: 'totalDebt', width: 15 },
      { header: 'Trạng thái', key: 'status', width: 12 },
    ];

    customers.forEach((customer) => {
      worksheet.addRow({
        code: customer.code,
        name: customer.name,
        phone: customer.phone || '',
        type: customer.customerType?.name || '',
        totalPurchased: customer.totalPurchased,
        totalDebt: customer.totalDebt,
        status: customer.isActive ? 'Hoạt động' : 'Ngừng',
      });
    });

    return await workbook.xlsx.writeBuffer();
  }

  private getOrderStatus(status: string): string {
    const statusMap = {
      pending: 'Chờ xử lý',
      processing: 'Đang xử lý',
      completed: 'Hoàn thành',
      cancelled: 'Đã hủy',
    };
    return statusMap[status] || status;
  }
}
