import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTagDto, UpdateTagDto } from './dto';

@Injectable()
export class TagsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.tag.findMany({
      include: {
        _count: {
          select: { posts: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.tag.findUnique({
      where: { id },
      include: {
        posts: {
          include: {
            post: {
              select: {
                id: true,
                title: true,
                status: true,
                publishedAt: true,
              },
            },
          },
        },
        _count: {
          select: { posts: true },
        },
      },
    });
  }

  async create(dto: CreateTagDto) {
    return this.prisma.tag.create({
      data: {
        name: dto.name,
        description: dto.description,
      },
    });
  }

  async update(id: number, dto: UpdateTagDto) {
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;

    return this.prisma.tag.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    return this.prisma.tag.delete({ where: { id } });
  }
}
