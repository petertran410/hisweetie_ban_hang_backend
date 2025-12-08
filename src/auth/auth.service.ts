import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || user.password !== password) {
      throw new Error('Invalid credentials');
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      token: 'mock-token',
    };
  }

  async register(data: { name: string; email: string; password: string }) {
    return this.prisma.user.create({
      data,
      select: {
        id: true,
        name: true,
        email: true,
      },
    });
  }
}
