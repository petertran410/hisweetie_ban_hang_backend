import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async findOne(id: number) {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async create(data: {
    name: string;
    email: string;
    password: string;
    phone?: string;
  }) {
    return this.prisma.user.create({
      data,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
      },
    });
  }

  async update(
    id: number,
    data: {
      name?: string;
      phone?: string;
      avatar?: string;
      isActive?: boolean;
    },
  ) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
        isActive: true,
      },
    });
  }
}
