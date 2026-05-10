import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrintTemplatesService {
  constructor(private prisma: PrismaService) {}

  // ==================== TEMPLATE CRUD ====================

  async findAll(params: { templateFor?: string; isActive?: boolean }) {
    return this.prisma.printTemplate.findMany({
      where: {
        ...(params.templateFor && { templateFor: params.templateFor }),
        ...(params.isActive !== undefined && { isActive: params.isActive }),
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(id: number) {
    const template = await this.prisma.printTemplate.findUnique({
      where: { id },
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async findByCode(code: string) {
    const template = await this.prisma.printTemplate.findFirst({
      where: { code },
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async create(data: any) {
    if (data.isDefault) {
      await this.prisma.printTemplate.updateMany({
        where: { templateFor: data.templateFor, isDefault: true },
        data: { isDefault: false },
      });
    }
    return this.prisma.printTemplate.create({ data });
  }

  async update(id: number, data: any) {
    const template = await this.prisma.printTemplate.findUnique({
      where: { id },
    });
    if (!template) throw new NotFoundException('Template not found');

    if (data.isDefault) {
      await this.prisma.printTemplate.updateMany({
        where: {
          templateFor: template.templateFor,
          isDefault: true,
          id: { not: id },
        },
        data: { isDefault: false },
      });
    }
    return this.prisma.printTemplate.update({ where: { id }, data });
  }

  async delete(id: number) {
    const template = await this.prisma.printTemplate.findUnique({
      where: { id },
    });
    if (!template) throw new NotFoundException('Template not found');
    if (template.isDefault)
      throw new BadRequestException('Cannot delete default template');
    await this.prisma.printTemplate.delete({ where: { id } });
    return { message: 'Template deleted successfully' };
  }

  // ==================== VARIABLES ====================

  async getVariables(templateFor: string) {
    const variables = await this.prisma.printTemplateVariable.findMany({
      where: { templateFor, isActive: true },
      orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }],
    });

    return variables.reduce(
      (acc, v) => {
        if (!acc[v.group]) acc[v.group] = [];
        acc[v.group].push({
          id: v.id,
          key: v.key,
          label: v.label,
          group: v.group,
          dataType: v.dataType,
          description: v.description,
          isItemVariable: v.isItemVariable,
        });
        return acc;
      },
      {} as Record<string, any[]>,
    );
  }

  async getAllVariables(templateFor?: string) {
    return this.prisma.printTemplateVariable.findMany({
      where: templateFor ? { templateFor } : {},
      orderBy: [{ templateFor: 'asc' }, { group: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async createVariable(data: any) {
    return this.prisma.printTemplateVariable.create({ data });
  }

  async updateVariable(id: number, data: any) {
    return this.prisma.printTemplateVariable.update({ where: { id }, data });
  }

  async deleteVariable(id: number) {
    return this.prisma.printTemplateVariable.delete({ where: { id } });
  }

  // ==================== REPLACE ENGINE ====================

  async replaceVariables(
    content: string,
    data: Record<string, any>,
    templateFor: string,
  ): Promise<string> {
    const items = data.items || [];
    let result = content;

    const itemKeys = await this.getItemVariableKeys(templateFor);

    if (itemKeys.size > 0 && items.length > 0) {
      result = this.replaceItemVariables(result, items, itemKeys);
    }

    for (const [key, value] of Object.entries(data)) {
      if (key !== 'items' && !Array.isArray(value)) {
        const regex = new RegExp(`{${key}}`, 'g');
        result = result.replace(regex, value?.toString() || '');
      }
    }

    return result;
  }

  private async getItemVariableKeys(templateFor: string): Promise<Set<string>> {
    const vars = await this.prisma.printTemplateVariable.findMany({
      where: { templateFor, isItemVariable: true, isActive: true },
      select: { key: true },
    });
    return new Set(vars.map((v) => v.key));
  }

  private replaceItemVariables(
    content: string,
    items: any[],
    itemKeys: Set<string>,
  ): string {
    const trRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const rows = content.match(trRegex) || [];

    for (const row of rows) {
      const hasItemVar = Array.from(itemKeys).some((k) =>
        row.includes(`{${k}}`),
      );
      if (!hasItemVar) continue;

      const clonedRows = items
        .map((item) => {
          let itemRow = row;
          for (const key of itemKeys) {
            const value = item[key] ?? '';
            itemRow = itemRow.replace(
              new RegExp(`{${key}}`, 'g'),
              value.toString(),
            );
          }
          return itemRow;
        })
        .join('');

      content = content.replace(row, clonedRows);
    }

    return content;
  }

  // ==================== DISPATCHER ====================

  async renderPreview(
    templateId: number,
    entityId: number,
    entityType?: string,
  ) {
    const template = await this.prisma.printTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) throw new NotFoundException('Template not found');

    const resolvedType = entityType ?? template.templateFor;
    const data = await this.loadEntityData(resolvedType, entityId);

    // ← Dùng template.templateFor (ví dụ 'delivery') thay vì resolvedType ('invoice_delivery')
    // để getItemVariableKeys query đúng bảng variables
    const content = await this.replaceVariables(
      template.content,
      data,
      template.templateFor,
    );

    return { content, data };
  }

  async renderWithData(templateId: number, entityData: any) {
    const template = await this.prisma.printTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) throw new NotFoundException('Template not found');

    // Ưu tiên _templateFor từ client (cho delivery sandbox), fallback về template.templateFor
    const resolvedType = entityData._templateFor || template.templateFor;

    let mapped: any;
    switch (resolvedType) {
      case 'order':
      case 'order_delivery':
        mapped = this.mapOrder(entityData);
        break;
      case 'invoice':
        mapped = this.mapInvoice(entityData);
        break;
      case 'invoice_delivery':
        mapped = {
          ...this.mapInvoice(entityData),
          Ma_Don_Hang: entityData.code || '',
        };
        break;
      case 'return_order':
        mapped = this.mapReturnOrder(entityData);
        break;
      default:
        mapped = entityData;
    }

    const content = await this.replaceVariables(
      template.content,
      mapped,
      template.templateFor,
    );

    return { content, data: mapped };
  }

  private async loadEntityData(
    templateFor: string,
    entityId: number,
  ): Promise<any> {
    switch (templateFor) {
      case 'invoice':
        return this.mapInvoice(await this.loadInvoice(entityId));
      case 'order':
        return this.mapOrder(await this.loadOrder(entityId));
      case 'order_supplier':
        return this.mapOrderSupplier(await this.loadOrderSupplier(entityId));
      case 'purchase_order':
        return this.mapPurchaseOrder(await this.loadPurchaseOrder(entityId));
      case 'return_order':
        return this.mapReturnOrder(await this.loadReturnOrder(entityId));
      case 'transfer':
        return this.mapTransfer(await this.loadTransfer(entityId));
      case 'cash_flow_receipt':
      case 'cash_flow_payment':
        return this.mapCashFlow(await this.loadCashFlow(entityId));
      case 'order_delivery':
        return this.mapOrder(await this.loadOrder(entityId));
      case 'invoice_delivery': {
        const inv = await this.loadInvoice(entityId);
        return {
          ...this.mapInvoice(inv),
          Ma_Don_Hang: inv.code || '',
        };
      }
      default:
        throw new BadRequestException(
          `Unsupported templateFor: ${templateFor}`,
        );
    }
  }

  // ==================== LOADERS ====================

  private async loadInvoice(id: number) {
    const entity = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        customer: {
          include: {
            addresses: {
              where: { isDefault: true },
              take: 1,
            },
          },
        },
        soldBy: true,
        creator: true,
        branch: true,
        delivery: true,
        details: { include: { product: true } },
      },
    });
    if (!entity) throw new NotFoundException('Invoice not found');
    return entity;
  }

  private async loadOrder(id: number) {
    const entity = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: {
          include: {
            addresses: {
              where: { isDefault: true },
              take: 1,
            },
          },
        },
        soldBy: true,
        creator: true,
        branch: true,
        delivery: true,
        items: { include: { product: true } },
      },
    });
    if (!entity) throw new NotFoundException('Order not found');
    return entity;
  }

  private async loadOrderSupplier(id: number) {
    const entity = await this.prisma.orderSupplier.findUnique({
      where: { id },
      include: {
        supplier: true,
        user: true,
        creator: true,
        branch: true,
        items: { include: { product: true } },
      },
    });
    if (!entity) throw new NotFoundException('OrderSupplier not found');
    return entity;
  }

  private async loadPurchaseOrder(id: number) {
    const entity = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: true,
        purchaseBy: true,
        creator: true,
        branch: true,
        items: { include: { product: true } },
      },
    });
    if (!entity) throw new NotFoundException('PurchaseOrder not found');
    return entity;
  }

  private async loadReturnOrder(id: number) {
    const entity = await this.prisma.returnOrder.findUnique({
      where: { id },
      include: {
        customer: {
          include: {
            addresses: {
              where: { isDefault: true },
              take: 1,
            },
          },
        },
        creator: true,
        branch: true,
        invoice: true,
        details: { include: { product: true } },
      },
    });
    if (!entity) throw new NotFoundException('ReturnOrder not found');
    return entity;
  }

  private async loadTransfer(id: number) {
    const entity = await this.prisma.transfer.findUnique({
      where: { id },
      include: {
        fromBranch: true,
        toBranch: true,
        creator: true,
        details: { include: { product: true } },
      },
    });
    if (!entity) throw new NotFoundException('Transfer not found');
    return entity;
  }

  private async loadCashFlow(id: number) {
    const entity = await this.prisma.cashFlow.findUnique({
      where: { id },
      include: { branch: true },
    });
    if (!entity) throw new NotFoundException('CashFlow not found');
    return entity;
  }

  // ==================== MAPPERS ====================

  private storeVars(branch: any) {
    return {
      Ten_Cua_Hang: branch?.name || '',
      Dia_Chi_Cua_Hang: branch?.address || '',
      So_Dien_Thoai_Cua_Hang: branch?.contactNumber || '',
      Chi_Nhanh_Ban_Hang: branch?.name || '',
    };
  }

  private dateVars(date: Date | null | undefined) {
    if (!date) return { Ngay: '', Thang: '', Nam: '' };
    const d = new Date(date);
    return {
      Ngay: d.toLocaleDateString('vi-VN'),
      Thang: (d.getMonth() + 1).toString(),
      Nam: d.getFullYear().toString(),
    };
  }

  private customerVars(customer: any, delivery?: any) {
    // Ưu tiên lấy địa chỉ từ delivery (snapshot tại thời điểm tạo)
    // Fallback lấy từ default address của customer
    const defaultAddr = customer?.addresses?.[0];

    return {
      Ma_Khach_Hang: customer?.code || '',
      Khach_Hang: customer?.name || 'Khách lẻ',
      So_Dien_Thoai: customer?.contactNumber || '',
      Dia_Chi_Khach_Hang: delivery?.address || defaultAddr?.address || '',
      Ghi_Chu_Khach_Hang: customer?.comments || '',
      Phuong_Xa_Khach_Hang:
        delivery?.wardName ||
        defaultAddr?.newWardName ||
        defaultAddr?.wardName ||
        '',
      Khu_Vuc_Khach_Hang_QH_TP:
        delivery?.locationName ||
        defaultAddr?.newCityName ||
        defaultAddr?.cityName ||
        '',
    };
  }

  private deliveryVars(delivery: any) {
    const weight = delivery?.weight ? Number(delivery.weight) : 0;
    const unit = delivery?.weightUnit || 'g';
    const formatted = weight
      ? `${new Intl.NumberFormat('en-US').format(weight)} ${unit}`
      : '';

    return {
      Nguoi_Nhan: delivery?.receiver || '',
      Dien_Thoai_Nhan: delivery?.contactNumber || '',
      Dia_Chi_Giao_Hang: delivery?.address || '',
      Phuong_Xa_Giao_Hang: delivery?.wardName || '',
      Khu_Vuc_Giao_Hang: delivery?.locationName || '',
      Ghi_Chu_Giao_Hang: delivery?.noteForDriver || '',
      Trang_Thai_Giao_Hang: delivery?.statusValue || '',
      Khoi_Luong: formatted,
    };
  }

  private staffVars(soldBy: any, creator: any) {
    return {
      Nhan_Vien_Ban_Hang: soldBy?.name || creator?.name || '',
      Nguoi_Lap: creator?.name || '',
      Dien_Thoai_Nguoi_Ban: soldBy?.phone || creator?.phone || '',
    };
  }

  private supplierVars(supplier: any) {
    return {
      Ma_Nha_Cung_Cap: supplier?.code || '',
      Ten_Nha_Cung_Cap: supplier?.name || '',
      So_Dien_Thoai_NCC: supplier?.contactNumber || '',
      Dia_Chi_NCC: supplier?.address || '',
    };
  }

  private money(value: any): string {
    return new Intl.NumberFormat('en-US').format(Number(value || 0));
  }

  private mapInvoice(inv: any) {
    return {
      ...this.storeVars(inv.branch),
      ...this.dateVars(inv.purchaseDate),
      ...this.customerVars(inv.customer, inv.delivery),
      ...this.staffVars(inv.soldBy, inv.creator),
      ...this.deliveryVars(inv.delivery),
      Ma_Hoa_Don: inv.code || '',
      Ghi_Chu: inv.description || '',
      Tong_Tien_Hang: this.money(inv.totalAmount),
      Giam_Gia: this.money(inv.discount),
      Tong_Can_Thanh_Toan: this.money(inv.grandTotal),
      Da_Thanh_Toan: this.money(inv.paidAmount),
      Con_Lai: this.money(inv.debtAmount),
      Tong_Can_Thanh_Toan_Bang_Chu: this.numberToWords(
        Number(inv.grandTotal || 0),
      ),
      items: (inv.details || []).map((i: any) => this.mapItem(i)),
    };
  }

  private mapOrder(o: any) {
    return {
      ...this.storeVars(o.branch),
      ...this.dateVars(o.orderDate),
      ...this.customerVars(o.customer, o.delivery),
      ...this.staffVars(o.soldBy, o.creator),
      ...this.deliveryVars(o.delivery),
      Ma_Don_Hang: o.code || '',
      Ghi_Chu: o.description || '',
      Tong_Tien_Hang: this.money(o.totalAmount),
      Giam_Gia: this.money(o.discount),
      Tong_Can_Thanh_Toan: this.money(o.grandTotal),
      Da_Thanh_Toan: this.money(o.paidAmount),
      Con_Lai: this.money(o.debtAmount),
      Tong_Can_Thanh_Toan_Bang_Chu: this.numberToWords(
        Number(o.grandTotal || 0),
      ),
      items: (o.items || []).map((i: any) => this.mapItem(i)),
    };
  }

  private mapOrderSupplier(os: any) {
    return {
      ...this.storeVars(os.branch),
      ...this.dateVars(os.orderDate),
      ...this.supplierVars(os.supplier),
      Ma_Dat_Hang_Nhap: os.code || '',
      Nhan_Vien_Ban_Hang: os.user?.name || os.creator?.name || '',
      Nguoi_Lap: os.creator?.name || '',
      Ghi_Chu: os.description || '',
      Tong_Tien_Hang: this.money(os.subTotal),
      Chiet_Khau_Hoa_Don: this.money(os.discount),
      Tong_Can_Thanh_Toan: this.money(os.totalAmt),
      Da_Thanh_Toan: this.money(os.paidAmount),
      Con_Lai: this.money(
        Number(os.totalAmt || 0) - Number(os.paidAmount || 0),
      ),
      Tong_Can_Thanh_Toan_Bang_Chu: this.numberToWords(
        Number(os.totalAmt || 0),
      ),
      items: (os.items || []).map((i: any) => this.mapItem(i)),
    };
  }

  private mapPurchaseOrder(po: any) {
    return {
      ...this.storeVars(po.branch),
      ...this.dateVars(po.purchaseDate),
      ...this.supplierVars(po.supplier),
      Ma_Nhap_Hang: po.code || '',
      Nhan_Vien_Ban_Hang: po.purchaseBy?.name || po.creator?.name || '',
      Nguoi_Lap: po.creator?.name || '',
      Ghi_Chu: po.description || '',
      Tong_Tien_Hang: this.money(po.subTotal),
      Chiet_Khau_Hoa_Don: this.money(po.discount),
      Tong_Can_Thanh_Toan: this.money(po.total),
      Da_Thanh_Toan: this.money(po.paidAmount),
      Con_Lai: this.money(Number(po.total || 0) - Number(po.paidAmount || 0)),
      Tong_Can_Thanh_Toan_Bang_Chu: this.numberToWords(Number(po.total || 0)),
      items: (po.items || []).map((i: any) => this.mapItem(i)),
    };
  }

  private mapReturnOrder(ro: any) {
    return {
      ...this.storeVars(ro.branch),
      ...this.dateVars(ro.createdAt),
      ...this.customerVars(ro.customer, null),
      Ma_Tra_Hang: ro.code || '',
      Ma_Don_Hang_Goc: ro.invoice?.code || '',
      Nhan_Vien_Ban_Hang: ro.creator?.name || '',
      Nguoi_Lap: ro.creator?.name || '',
      Ghi_Chu: ro.note || '',
      Tong_Tien_Tra: this.money(ro.refundAmount || ro.totalReturnAmount),
      Da_Hoan_Tra: this.money(ro.refundedAmount),
      items: (ro.details || []).map((d: any) => ({
        Ma_Hang: d.productCode || '',
        Ten_Hang_Hoa: d.productName || '',
        Don_Vi_Tinh: '',
        So_Luong: Number(d.requestQuantity),
        Don_Gia: this.money(d.returnPrice),
        Don_Gia_Sau_Chiet_Khau: this.money(d.returnPrice),
        Ghi_Chu_Hang_Hoa: d.note || '',
        Thanh_Tien: this.money(d.totalAmount),
      })),
    };
  }

  private mapTransfer(t: any) {
    return {
      Ten_Cua_Hang: t.fromBranch?.name || '',
      Dia_Chi_Cua_Hang: t.fromBranch?.address || '',
      So_Dien_Thoai_Cua_Hang: t.fromBranch?.contactNumber || '',
      ...this.dateVars(t.transferredDate || t.createdAt),
      Ma_Chuyen_Hang: t.code || '',
      Chi_Nhanh_Nguon: t.fromBranchName || t.fromBranch?.name || '',
      Chi_Nhanh_Dich: t.toBranchName || t.toBranch?.name || '',
      Nhan_Vien_Ban_Hang: t.creator?.name || '',
      Nguoi_Lap: t.createdByName || t.creator?.name || '',
      Ghi_Chu: t.noteBySource || '',
      Tong_Tien_Chuyen: this.money(t.totalTransfer),
      items: (t.details || []).map((d: any) => ({
        Ma_Hang: d.productCode || '',
        Ten_Hang_Hoa: d.productName || '',
        Don_Vi_Tinh: '',
        So_Luong: Number(d.sendQuantity),
        Don_Gia: this.money(d.sendPrice),
        Don_Gia_Sau_Chiet_Khau: this.money(d.sendPrice),
        Ghi_Chu_Hang_Hoa: '',
        Thanh_Tien: this.money(d.totalTransfer),
      })),
    };
  }

  private mapCashFlow(cf: any) {
    const codeKey = cf.isReceipt ? 'Ma_Phieu_Thu' : 'Ma_Phieu_Chi';
    const partnerKey = cf.isReceipt ? 'Nguoi_Nop' : 'Nguoi_Nhan';
    const addrKey = cf.isReceipt ? 'Dia_Chi_Nguoi_Nop' : 'Dia_Chi_Nguoi_Nhan';
    const reasonKey = cf.isReceipt ? 'Ly_Do_Thu' : 'Ly_Do_Chi';

    return {
      ...this.storeVars(cf.branch),
      ...this.dateVars(cf.transDate),
      [codeKey]: cf.code || '',
      [partnerKey]: cf.partnerName || '',
      [addrKey]: cf.address || '',
      Nhan_Vien_Ban_Hang: '',
      Nguoi_Lap: '',
      [reasonKey]: cf.description || '',
      So_Tien: this.money(cf.amount),
      So_Tien_Bang_Chu: this.numberToWords(Number(cf.amount || 0)),
    };
  }

  private mapItem(item: any) {
    return {
      Ma_Hang: item.productCode || item.product?.code || '',
      Ten_Hang_Hoa: item.productName || item.product?.name || '',
      Don_Vi_Tinh: item.product?.unit || '',
      So_Luong: Number(item.quantity),
      Don_Gia: this.money(item.price),
      Giam_Gia_Don_Gia: this.money(item.discount),
      Ghi_Chu_Hang_Hoa: item.note || item.description || '',
      Thanh_Tien: this.money(item.totalPrice || item.subTotal),
    };
  }

  // ==================== NUMBER TO WORDS ====================

  private numberToWords(num: number): string {
    if (num === 0) return 'Không đồng';
    const ones = [
      '',
      'một',
      'hai',
      'ba',
      'bốn',
      'năm',
      'sáu',
      'bảy',
      'tám',
      'chín',
    ];
    const tens = [
      '',
      'mười',
      'hai mươi',
      'ba mươi',
      'bốn mươi',
      'năm mươi',
      'sáu mươi',
      'bảy mươi',
      'tám mươi',
      'chín mươi',
    ];

    const convert = (n: number): string => {
      if (n < 10) return ones[n];
      if (n < 100) {
        const ten = Math.floor(n / 10);
        const one = n % 10;
        return tens[ten] + (one ? ' ' + ones[one] : '');
      }
      if (n < 1000) {
        const hundred = Math.floor(n / 100);
        const rest = n % 100;
        return ones[hundred] + ' trăm' + (rest ? ' ' + convert(rest) : '');
      }
      if (n < 1000000) {
        const thousand = Math.floor(n / 1000);
        const rest = n % 1000;
        return convert(thousand) + ' nghìn' + (rest ? ' ' + convert(rest) : '');
      }
      if (n < 1000000000) {
        const million = Math.floor(n / 1000000);
        const rest = n % 1000000;
        return convert(million) + ' triệu' + (rest ? ' ' + convert(rest) : '');
      }
      const billion = Math.floor(num / 1000000000);
      const rest = num % 1000000000;
      return convert(billion) + ' tỷ' + (rest ? ' ' + convert(rest) : '');
    };

    const words = convert(Math.floor(num)) + ' đồng';
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
}
