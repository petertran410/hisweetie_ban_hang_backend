import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateNoteTemplateDto, UpdateNoteTemplateDto } from './dto';

@Injectable()
export class NoteTemplatesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.noteTemplate.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findOne(id: number) {
    const template = await this.prisma.noteTemplate.findUnique({
      where: { id },
    });

    if (!template) {
      throw new NotFoundException(`Note template with ID ${id} not found`);
    }

    return template;
  }

  async create(dto: CreateNoteTemplateDto) {
    return this.prisma.noteTemplate.create({
      data: {
        content: dto.content,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(id: number, dto: UpdateNoteTemplateDto) {
    await this.findOne(id);
    return this.prisma.noteTemplate.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.noteTemplate.delete({
      where: { id },
    });
  }
}
