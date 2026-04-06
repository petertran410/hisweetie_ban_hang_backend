import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrintTemplatesService {
  constructor(private prisma: PrismaService) {}

  async findAll(filters?: { templateFor?: string; isActive?: boolean }) {
    const where: any = {};

    if (filters?.templateFor) where.templateFor = filters.templateFor;
    if (filters?.isActive !== undefined) where.isActive = filters.isActive;

    return this.prisma.printTemplate.findMany({
      where,
      include: { creator: { select: { id: true, name: true } } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(id: number) {
    const template = await this.prisma.printTemplate.findUnique({
      where: { id },
      include: { creator: { select: { id: true, name: true } } },
    });

    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async findByCode(code: string) {
    const template = await this.prisma.printTemplate.findUnique({
      where: { code },
    });

    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async create(data: {
    name: string;
    code: string;
    templateFor: string;
    content: string;
    isDefault?: boolean;
    createdBy: number;
  }) {
    const existing = await this.prisma.printTemplate.findUnique({
      where: { code: data.code },
    });

    if (existing) {
      throw new BadRequestException('Template code already exists');
    }

    if (data.isDefault) {
      await this.prisma.printTemplate.updateMany({
        where: {
          templateFor: data.templateFor,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    return this.prisma.printTemplate.create({ data });
  }

  async update(
    id: number,
    data: {
      name?: string;
      content?: string;
      isActive?: boolean;
      isDefault?: boolean;
    },
  ) {
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

    return this.prisma.printTemplate.update({
      where: { id },
      data,
    });
  }

  async delete(id: number) {
    const template = await this.prisma.printTemplate.findUnique({
      where: { id },
    });
    if (!template) throw new NotFoundException('Template not found');

    if (template.isDefault) {
      throw new BadRequestException('Cannot delete default template');
    }

    await this.prisma.printTemplate.delete({ where: { id } });
    return { message: 'Template deleted successfully' };
  }

  replaceVariables(content: string, data: Record<string, any>): string {
    let result = content;

    for (const [key, value] of Object.entries(data)) {
      const regex = new RegExp(`{${key}}`, 'g');
      result = result.replace(regex, value?.toString() || '');
    }

    return result;
  }

  async getVariables(templateFor: string) {
    const variables = await this.prisma.printTemplateVariable.findMany({
      where: {
        templateFor,
        isActive: true,
      },
      orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }],
    });

    return variables.reduce(
      (acc, v) => {
        const groupKey = v.group;
        if (!acc[groupKey]) acc[groupKey] = [];
        acc[groupKey].push({
          id: v.id,
          key: v.key,
          label: v.label,
          group: v.group,
          dataType: v.dataType,
          description: v.description,
        });
        return acc;
      },
      {} as Record<string, any[]>,
    );
  }

  async getAllVariables(templateFor?: string) {
    const where = templateFor ? { templateFor } : {};

    return this.prisma.printTemplateVariable.findMany({
      where,
      orderBy: [{ templateFor: 'asc' }, { group: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async createVariable(data: any) {
    return this.prisma.printTemplateVariable.create({ data });
  }

  async updateVariable(id: number, data: any) {
    return this.prisma.printTemplateVariable.update({
      where: { id },
      data,
    });
  }

  async deleteVariable(id: number) {
    return this.prisma.printTemplateVariable.delete({ where: { id } });
  }

  async renderPreview(templateId: number, entityId: number) {
    const template = await this.prisma.printTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) throw new NotFoundException('Template not found');

    let data: any = {};

    if (template.templateFor === 'invoice') {
      const invoice = await this.prisma.invoice.findUnique({
        where: { id: entityId },
        include: {
          customer: true,
          soldBy: true,
          creator: true,
          branch: true,
          details: {
            include: { product: true },
          },
        },
      });

      if (!invoice) throw new NotFoundException('Invoice not found');

      data = this.mapInvoiceToVariables(invoice);
    }

    const renderedContent = this.replaceVariables(template.content, data);

    return {
      content: renderedContent,
      data,
    };
  }

  private mapInvoiceToVariables(invoice: any) {
    const totalDiscount = Number(invoice.discount || 0);
    const discountRatio = Number(invoice.discountRatio || 0);

    return {
      Ma_Don_Hang: invoice.code || '',
      Ngay: invoice.purchaseDate
        ? new Date(invoice.purchaseDate).toLocaleDateString('vi-VN')
        : '',
      Khu_Vuc_Chi_Nhanh_QH_TP: invoice.branch?.name || '',

      Ma_Khach_Hang: invoice.customer?.code || '',
      Khach_Hang: invoice.customer?.name || 'Khách lẻ',
      So_Dien_Thoai: invoice.customer?.phone || '',
      Dia_Chi_Khach_Hang: invoice.customer?.address || '',
      Phuong_Xa_Khach_Hang: invoice.customer?.wardName || '',
      Khu_Vuc_Khach_Hang_QH_TP: invoice.customer?.locationName || '',
      Ghi_Chu_Khach_Hang: invoice.customer?.comments || '',
      Ghi_Chu: invoice.description || '',

      Nhan_Vien_Ban_Hang: invoice.soldBy?.name || invoice.creator?.name || '',
      Dien_Thoai_Nguoi_Ban:
        invoice.soldBy?.phone || invoice.creator?.phone || '',

      Tong_Tien_Hang: new Intl.NumberFormat('vi-VN').format(
        Number(invoice.totalAmount),
      ),
      Chiet_Khau_Hoa_Don_Phan_Tram: `${discountRatio}%`,
      Chiet_Khau_Hoa_Don: new Intl.NumberFormat('vi-VN').format(totalDiscount),
      Da_Thanh_Toan_Ten_Phuong_Thuc_Ttoan: new Intl.NumberFormat(
        'vi-VN',
      ).format(Number(invoice.paidAmount)),
      Can_Thanh_Toan: new Intl.NumberFormat('vi-VN').format(
        Number(invoice.debtAmount),
      ),
      Tong_Can_Thanh_Toan_Bang_Chu: this.numberToWords(
        Number(invoice.grandTotal),
      ),

      items: (invoice.details || []).map((item: any) => ({
        Ten_Hang_Hoa: item.productName || item.product?.name || '',
        Ghi_Chu_Hang_Hoa: item.note || '',
        Don_Gia_Sau_Chiet_Khau: new Intl.NumberFormat('vi-VN').format(
          Number(item.price),
        ),
        So_Luong: Number(item.quantity),
        Thanh_Tien: new Intl.NumberFormat('vi-VN').format(
          Number(item.totalPrice),
        ),
      })),
    };
  }

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
      return 'Số quá lớn';
    };

    return convert(Math.floor(num)) + ' đồng';
  }
}
