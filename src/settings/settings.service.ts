import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateSettingsDto } from './dto';

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async getSettings() {
    let settings = await this.prisma.settings.findFirst();

    if (!settings) {
      settings = await this.prisma.settings.create({
        data: {
          managerCustomerByBranch: false,
          allowOrderWhenOutStock: true,
          allowSellWhenOrderOutStock: true,
          allowSellWhenOutStock: true,
        },
      });
    }

    return settings;
  }

  async updateSettings(dto: UpdateSettingsDto) {
    const settings = await this.getSettings();

    return this.prisma.settings.update({
      where: { id: settings.id },
      data: {
        managerCustomerByBranch: dto.managerCustomerByBranch,
        allowOrderWhenOutStock: dto.allowOrderWhenOutStock,
        allowSellWhenOrderOutStock: dto.allowSellWhenOrderOutStock,
        allowSellWhenOutStock: dto.allowSellWhenOutStock,
      },
    });
  }
}
