import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePostMetaDto, UpdatePostMetaDto } from './dto';

@Injectable()
export class PostMetaService {
  constructor(private prisma: PrismaService) {}

  async findAllByPost(postId: number) {
    return this.prisma.postMeta.findMany({
      where: { postId },
      orderBy: { metaKey: 'asc' },
    });
  }

  async findOne(postId: number, metaKey: string) {
    return this.prisma.postMeta.findUnique({
      where: {
        postId_metaKey: { postId, metaKey },
      },
    });
  }

  async create(dto: CreatePostMetaDto) {
    return this.prisma.postMeta.create({
      data: dto,
    });
  }

  async update(postId: number, metaKey: string, dto: UpdatePostMetaDto) {
    return this.prisma.postMeta.update({
      where: {
        postId_metaKey: { postId, metaKey },
      },
      data: dto,
    });
  }

  async upsert(postId: number, metaKey: string, metaValue: string) {
    return this.prisma.postMeta.upsert({
      where: {
        postId_metaKey: { postId, metaKey },
      },
      create: { postId, metaKey, metaValue },
      update: { metaValue },
    });
  }

  async remove(postId: number, metaKey: string) {
    return this.prisma.postMeta.delete({
      where: {
        postId_metaKey: { postId, metaKey },
      },
    });
  }
}
