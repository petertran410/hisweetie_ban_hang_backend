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

  private async loadEntityData(
    templateFor: string,
    entityId: number,
  ): Promise<any> {
    switch (templateFor) {
      case 'invoice':
        return this.mapInvoice(await this.loadInvoice(entityId));
      case 'order':
        return this.mapOrder(await this.loadOrder(entityId));
      case 'consignment':
        return this.mapConsignment(await this.loadConsignment(entityId));
      case 'consignment_return':
        return this.mapConsignmentReturn(
          await this.loadConsignmentReturn(entityId),
        );
      case 'order_supplier':
        return this.mapOrderSupplier(await this.loadOrderSupplier(entityId));
      case 'purchase_order':
        return this.mapPurchaseOrder(await this.loadPurchaseOrder(entityId));
      case 'return_order':
        return this.mapReturnOrder(await this.loadReturnOrder(entityId));
      case 'transfer':
        return this.mapTransfer(await this.loadTransfer(entityId));
      case 'internal_use':
        return this.mapInternalUse(await this.loadInternalUse(entityId));
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
        soldBy: {
          include: {
            bankAccountMapping: {
              include: { bankAccount: true },
            },
          },
        },
        creator: true,
        branch: true,
        delivery: true,
        details: {
          include: {
            product: true,
            promotion: { select: { code: true, name: true } },
          },
        },
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
        soldBy: {
          include: {
            bankAccountMapping: {
              include: { bankAccount: true },
            },
          },
        },
        creator: true,
        branch: true,
        delivery: true,
        items: {
          include: {
            product: true,
            promotion: { select: { code: true, name: true } },
          },
        },
      },
    });
    if (!entity) throw new NotFoundException('Order not found');
    return entity;
  }

  private async loadConsignment(id: number) {
    const entity = await this.prisma.consignment.findUnique({
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
        soldBy: {
          include: {
            bankAccountMapping: {
              include: { bankAccount: true },
            },
          },
        },
        creator: true,
        branch: true,
        delivery: true,
        items: { include: { product: true } },
      },
    });
    if (!entity) throw new NotFoundException('Consignment not found');
    return entity;
  }

  private async loadConsignmentReturn(id: number) {
    const entity = await this.prisma.consignmentReturn.findUnique({
      where: { id },
      include: {
        branch: true,
        customer: {
          include: {
            addresses: {
              where: { isDefault: true },
              take: 1,
            },
          },
        },
        consignment: {
          include: { creator: true, delivery: true },
        },
        details: { include: { product: true } },
      },
    });
    if (!entity) throw new NotFoundException('ConsignmentReturn not found');
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

  private async loadInternalUse(id: number) {
    const entity = await this.prisma.internalUse.findUnique({
      where: { id },
      include: {
        branch: true,
        creator: true,
        user: true,
        purpose: true,
        details: { include: { product: true } },
      },
    });
    if (!entity) throw new NotFoundException('InternalUse not found');
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
      // Địa chỉ cũ (3 cấp) — để shipper đối chiếu với địa chỉ cũ khi cần.
      // Lấy từ snapshot delivery (ưu tiên), fallback default address của khách.
      Phuong_Xa_Cu_Khach_Hang:
        delivery?.oldWardName || defaultAddr?.wardName || '',
      Quan_Huyen_Cu_Khach_Hang:
        delivery?.oldDistrictName || defaultAddr?.districtName || '',
      Tinh_Thanh_Cu_Khach_Hang:
        delivery?.oldCityName || defaultAddr?.cityName || '',
    };
  }

  private deliveryVars(delivery: any, customer?: any) {
    const weight = delivery?.weight ? Number(delivery.weight) : 0;
    const unit = delivery?.weightUnit || 'g';
    const formatted = weight
      ? `${new Intl.NumberFormat('en-US').format(weight)} ${unit}`
      : '';

    // Fallback lấy từ default address của customer khi delivery snapshot trống
    const defaultAddr = customer?.addresses?.[0];

    return {
      Nguoi_Nhan: delivery?.receiver || customer?.name || '',
      Dien_Thoai_Nhan: delivery?.contactNumber || customer?.contactNumber || '',
      Dia_Chi_Giao_Hang: delivery?.address || defaultAddr?.address || '',
      Phuong_Xa_Giao_Hang:
        delivery?.wardName ||
        defaultAddr?.newWardName ||
        defaultAddr?.wardName ||
        '',
      Khu_Vuc_Giao_Hang:
        delivery?.locationName ||
        defaultAddr?.newCityName ||
        defaultAddr?.cityName ||
        '',
      // Địa chỉ cũ (3 cấp) — để shipper đối chiếu với địa chỉ cũ khi cần.
      Phuong_Xa_Cu_Giao_Hang:
        delivery?.oldWardName || defaultAddr?.wardName || '',
      Quan_Huyen_Cu_Giao_Hang:
        delivery?.oldDistrictName || defaultAddr?.districtName || '',
      Tinh_Thanh_Cu_Giao_Hang:
        delivery?.oldCityName || defaultAddr?.cityName || '',
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

  private generateVietQRUrl(
    bank: any,
    amount: number,
    addInfo: string,
  ): string {
    const params = new URLSearchParams();
    if (amount > 0) params.append('amount', String(amount));
    if (addInfo) params.append('addInfo', addInfo);
    if (bank.accountHolder) params.append('accountName', bank.accountHolder);
    return `https://img.vietqr.io/image/${encodeURIComponent(
      bank.bankCode,
    )}-${encodeURIComponent(bank.accountNumber)}-compact1.png?${params.toString()}`;
  }

  private qrVars(soldBy: any, amount: any, addInfo: string) {
    const bank = soldBy?.bankAccountMapping?.bankAccount;
    if (!bank) {
      return {
        Ma_QR_Code: '',
        Ten_Ngan_Hang_QR: '',
        So_Tai_Khoan_QR: '',
        Chu_Tai_Khoan_QR: '',
      };
    }

    const amt = Math.round(Number(amount || 0));
    const url = this.generateVietQRUrl(bank, amt, addInfo);

    return {
      Ma_QR_Code: `<img src="${url}" alt="QR thanh toan" style="width:160px;height:160px;" />`,
      Ten_Ngan_Hang_QR: bank.bankName || '',
      So_Tai_Khoan_QR: bank.accountNumber || '',
      Chu_Tai_Khoan_QR: bank.accountHolder || '',
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
      ...this.deliveryVars(inv.delivery, inv.customer),
      ...this.qrVars(inv.soldBy, inv.grandTotal, inv.code),
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
      ...this.deliveryVars(o.delivery, o.customer),
      ...this.qrVars(o.soldBy, o.grandTotal, o.code),
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

  private mapConsignment(c: any) {
    return {
      ...this.storeVars(c.branch),
      ...this.dateVars(c.consignDate),
      ...this.customerVars(c.customer, c.delivery),
      ...this.staffVars(c.soldBy, c.creator),
      ...this.deliveryVars(c.delivery, c.customer),
      ...this.qrVars(c.soldBy, c.grandTotal, c.code),
      Ma_Ky_Gui: c.code || '',
      Ma_Don_Hang: c.code || '',
      Ghi_Chu: c.description || '',
      Tong_Tien_Hang: this.money(c.totalAmount),
      Giam_Gia: this.money(c.discount),
      Tong_Can_Thanh_Toan: this.money(c.grandTotal),
      Tong_Can_Thanh_Toan_Bang_Chu: this.numberToWords(
        Number(c.grandTotal || 0),
      ),
      items: (c.items || []).map((i: any) => this.mapItem(i)),
    };
  }

  private mapConsignmentReturn(r: any) {
    const c = r.consignment;
    return {
      ...this.storeVars(r.branch),
      ...this.dateVars(r.createdAt),
      ...this.customerVars(r.customer, c?.delivery),
      ...this.deliveryVars(c?.delivery, r.customer),
      Ma_Hoan_Ky_Gui: r.code || '',
      Ma_Ky_Gui: r.consignmentCode || c?.code || '',
      Nguoi_Lap: c?.creator?.name || '',
      Nhan_Vien_Ban_Hang: c?.creator?.name || '',
      Ghi_Chu: r.note || '',
      Tong_SL_Hoan: Number(r.totalReturnQuantity || 0),
      items: (r.details || []).map((d: any) => ({
        Ma_Hang: d.productCode || d.product?.code || '',
        Ten_Hang_Hoa: d.productName || d.product?.name || '',
        NSX: d.manufactureDate
          ? new Date(d.manufactureDate).toLocaleDateString('vi-VN')
          : '',
        SL_Hoan: Number(d.returnQuantity || 0),
        Hang_Tot: Number(d.goodQuantity || 0),
        Loai_B: Number(d.damagedQuantity || 0),
        Can_Date: Number(d.nearExpiryQuantity || 0),
        Ghi_Chu_Hang_Hoa: d.note || '',
      })),
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
      items: (po.items || []).map((i: any) => this.mapItemPurchaseOrder(i)),
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
    const receivedDate = this.dateVars(t.receivedDate);
    return {
      Ten_Cua_Hang: t.fromBranch?.name || '',
      Dia_Chi_Cua_Hang: t.fromBranch?.address || '',
      So_Dien_Thoai_Cua_Hang: t.fromBranch?.contactNumber || '',
      ...this.dateVars(t.transferredDate || t.createdAt),
      // Ngày nhận (chi nhánh đích) — tách riêng để không đè ngày chuyển
      Ngay_Nhan: receivedDate.Ngay,
      Thang_Nhan: receivedDate.Thang,
      Nam_Nhan: receivedDate.Nam,
      Ma_Chuyen_Hang: t.code || '',
      Chi_Nhanh_Nguon: t.fromBranchName || t.fromBranch?.name || '',
      Chi_Nhanh_Dich: t.toBranchName || t.toBranch?.name || '',
      Nhan_Vien_Ban_Hang: t.creator?.name || '',
      Nguoi_Lap: t.createdByName || t.creator?.name || '',
      // Ghi_Chu giữ nguyên = ghi chú bên chuyển (backward-compat)
      Ghi_Chu: t.noteBySource || '',
      Ghi_Chu_Chuyen: t.noteBySource || '',
      Ghi_Chu_Nhan: t.noteByDestination || '',
      Tong_Tien_Chuyen: this.money(t.totalTransfer),
      Tong_Tien_Nhan: this.money(t.totalReceive),
      items: (t.details || []).map((d: any) => ({
        Ma_Hang: d.productCode || '',
        Ten_Hang_Hoa: d.productName || '',
        Don_Vi_Tinh: '',
        So_Luong: Number(d.sendQuantity),
        So_Luong_Nhan: Number(d.receivedQuantity),
        Don_Gia: this.money(d.sendPrice),
        Don_Gia_Sau_Chiet_Khau: this.money(d.sendPrice),
        Ghi_Chu_Hang_Hoa: '',
        Thanh_Tien: this.money(d.totalTransfer),
        Thanh_Tien_Nhan: this.money(d.totalReceive),
      })),
    };
  }

  private mapInternalUse(iu: any) {
    const totalValue = Number(iu.totalValue || 0);
    return {
      ...this.storeVars(iu.branch),
      ...this.dateVars(iu.transDate || iu.createdAt),
      Ma_Xuat_Dung_Noi_Bo: iu.code || '',
      Chi_Nhanh: iu.branchName || iu.branch?.name || '',
      Muc_Dich_Su_Dung: iu.purpose?.name || '',
      Nguoi_Su_Dung: iu.userName || iu.user?.name || '',
      Nhan_Vien_Ban_Hang: iu.creator?.name || '',
      Nguoi_Lap: iu.createdByName || iu.creator?.name || '',
      Ghi_Chu: iu.description || '',
      Tong_Gia_Tri: this.money(totalValue),
      Tong_Gia_Tri_Bang_Chu: this.numberToWords(totalValue),
      items: (iu.details || []).map((d: any) => ({
        Ma_Hang: d.productCode || d.product?.code || '',
        Ten_Hang_Hoa: d.productName || d.product?.name || '',
        Don_Vi_Tinh: d.unit || d.product?.unit || '',
        So_Luong: Number(d.quantity),
        Gia_Von: this.money(d.cost),
        Gia_Tri_Xuat: this.money(d.value),
        Thanh_Tien: this.money(d.value),
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
    const price = Number(item.price || 0);
    const discount = Number(item.discount || 0);
    const discountRatio = Number(item.discountRatio || 0);
    const priceAfterDiscount =
      item.appliedPrice != null
        ? Number(item.appliedPrice)
        : price - discount - (price * discountRatio) / 100;

    // Phân loại dòng theo KM:
    // - gift/discounted_buy → hàng thưởng (reward)
    // - normal/promo_discount + có promotionId → hàng thuộc CT khuyến mãi (dòng X)
    // - còn lại → hàng bán thường
    const lineType = item.lineType || 'normal';
    const isReward =
      item.isGift || lineType === 'gift' || lineType === 'discounted_buy';
    const isPromoBuy =
      !isReward &&
      (lineType === 'normal' || lineType === 'promo_discount') &&
      item.promotionId != null;

    let loaiDongKM = '';
    if (lineType === 'gift' || item.isGift) loaiDongKM = 'Quà tặng';
    else if (lineType === 'discounted_buy') loaiDongKM = 'Mua kèm KM';
    else if (isPromoBuy) loaiDongKM = 'Hàng KM';

    const baseName = item.productName || item.product?.name || '';
    // Nhãn chèn mặc định vào tên hàng (hiện ngay trên template cũ, chỉ chữ).
    const nameSuffix =
      lineType === 'gift' || item.isGift
        ? ' (Quà KM)'
        : lineType === 'discounted_buy'
          ? ' (Mua kèm KM)'
          : isPromoBuy
            ? ' (KM)'
            : '';

    return {
      Ma_Hang: item.productCode || item.product?.code || '',
      Ten_Hang_Hoa: baseName + nameSuffix,
      Don_Vi_Tinh: item.product?.unit || '',
      So_Luong: Number(item.quantity),
      Don_Gia: this.money(item.price),
      Chiet_Khau_Phan_Tram: discountRatio ? String(discountRatio) : '',
      Chiet_Khau_Tien: discount ? this.money(discount) : '',
      Giam_Gia_Don_Gia: this.money(item.discount),
      Don_Gia_Sau_Chiet_Khau: this.money(priceAfterDiscount),
      Ghi_Chu_Hang_Hoa: item.note || item.description || '',
      Thanh_Tien: this.money(item.totalPrice || item.subTotal),
      NSX: item.manufactureDate
        ? new Date(item.manufactureDate).toLocaleDateString('vi-VN')
        : '',
      // Biến KM (item-variable) — người dùng có thể chèn vào template để tạo cột riêng.
      Loai_Dong_KM: loaiDongKM,
      La_Hang_KM: isReward || isPromoBuy ? '1' : '',
      Ma_KM: item.promotion?.code || '',
      Ten_KM: item.promotion?.name || '',
    };
  }

  // Mapper riêng cho phiếu nhập hàng (purchase_order):
  // - Bỏ Giam_Gia_Don_Gia (trùng ý nghĩa với Don_Gia_Sau_Chiet_Khau)
  // - Bỏ Loai_Dong_KM / La_Hang_KM / Ma_KM / Ten_KM (phiếu nhập không cần KM)
  // - Bổ sung Chiet_Khau_Phan_Tram + Chiet_Khau_Tien
  private mapItemPurchaseOrder(item: any) {
    const price = Number(item.price || 0);
    const discount = Number(item.discount || 0);
    const discountRatio = Number(item.discountRatio || 0);
    const priceAfterDiscount =
      item.appliedPrice != null
        ? Number(item.appliedPrice)
        : price - discount - (price * discountRatio) / 100;

    return {
      Ma_Hang: item.productCode || item.product?.code || '',
      Ten_Hang_Hoa: item.productName || item.product?.name || '',
      Don_Vi_Tinh: item.product?.unit || '',
      So_Luong: Number(item.quantity),
      Don_Gia: this.money(price),
      Chiet_Khau_Phan_Tram: discountRatio ? String(discountRatio) : '',
      Chiet_Khau_Tien: discount ? this.money(discount) : '',
      Don_Gia_Sau_Chiet_Khau: this.money(priceAfterDiscount),
      Ghi_Chu_Hang_Hoa: item.note || item.description || '',
      Thanh_Tien: this.money(item.totalPrice || item.subTotal),
      NSX: item.manufactureDate
        ? new Date(item.manufactureDate).toLocaleDateString('vi-VN')
        : '',
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
