import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePostDto, UpdatePostDto, PostQueryDto } from './dto';

@Injectable()
export class PostsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreatePostDto, userId: number) {
    const data: any = {
      title: dto.title,
      content: dto.content,
      excerpt: dto.excerpt,
      featuredImage: dto.featuredImage,
      status: dto.status || 'draft',
      publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : null,
      authorId: userId,
    };

    if (dto.tagIds && dto.tagIds.length > 0) {
      data.tags = {
        create: dto.tagIds.map((tagId) => ({ tagId })),
      };
    }

    return this.prisma.post.create({
      data,
      include: {
        author: { select: { id: true, name: true, email: true } },
        tags: { include: { tag: true } },
        postMeta: true,
      },
    });
  }

  async findAll(query: PostQueryDto) {
    const { page = 1, limit = 10, search, status, authorId } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status) where.status = status;
    if (authorId) where.authorId = authorId;

    const [data, total] = await Promise.all([
      this.prisma.post.findMany({
        where,
        skip,
        take: limit,
        include: {
          author: { select: { id: true, name: true, email: true } },
          tags: { include: { tag: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.post.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    return this.prisma.post.findUnique({
      where: { id },
      include: {
        author: { select: { id: true, name: true, email: true } },
        tags: { include: { tag: true } },
        postMeta: true,
      },
    });
  }

  async update(id: number, dto: UpdatePostDto) {
    const data: any = {};

    if (dto.title !== undefined) data.title = dto.title;
    if (dto.content !== undefined) data.content = dto.content;
    if (dto.excerpt !== undefined) data.excerpt = dto.excerpt;
    if (dto.featuredImage !== undefined) data.featuredImage = dto.featuredImage;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.publishedAt !== undefined)
      data.publishedAt = dto.publishedAt ? new Date(dto.publishedAt) : null;

    if (dto.tagIds !== undefined) {
      await this.prisma.postTag.deleteMany({ where: { postId: id } });
      if (dto.tagIds.length > 0) {
        data.tags = {
          create: dto.tagIds.map((tagId) => ({ tagId })),
        };
      }
    }

    return this.prisma.post.update({
      where: { id },
      data,
      include: {
        author: { select: { id: true, name: true, email: true } },
        tags: { include: { tag: true } },
        postMeta: true,
      },
    });
  }

  async remove(id: number) {
    return this.prisma.post.delete({ where: { id } });
  }

  async publish(id: number) {
    return this.prisma.post.update({
      where: { id },
      data: {
        status: 'published',
        publishedAt: new Date(),
      },
    });
  }

  async unpublish(id: number) {
    return this.prisma.post.update({
      where: { id },
      data: { status: 'draft' },
    });
  }
}
