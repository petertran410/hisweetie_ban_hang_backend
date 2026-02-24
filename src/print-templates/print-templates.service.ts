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
}
