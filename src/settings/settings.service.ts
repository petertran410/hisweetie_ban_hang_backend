import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateSettingsDto } from './dto';
import { AuditLogsService } from 'src/audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from 'src/audit-logs/audit-templates';

@Injectable()
export class SettingsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async getSettings() {
    let settings = await this.prisma.settings.findFirst();

    if (!settings) {
      settings = await this.prisma.settings.create({
        data: {
          managerCustomerByBranch: false,
          allowOrderWhenOutStock: true,
          allowSellWhenOrderOutStock: true,
          allowSellWhenOutStock: true,
          syncKiotEnabled: true,
          larkProductRetryCronEnabled: true,
          misaDictionaryCronEnabled: false,
        },
      });
    }

    return settings;
  }

  async updateSettings(dto: UpdateSettingsDto, userId?: number) {
    const settings = await this.getSettings();

    const before = {
      managerCustomerByBranch: settings.managerCustomerByBranch,
      allowOrderWhenOutStock: settings.allowOrderWhenOutStock,
      allowSellWhenOrderOutStock: settings.allowSellWhenOrderOutStock,
      allowSellWhenOutStock: settings.allowSellWhenOutStock,
      syncKiotEnabled: settings.syncKiotEnabled,
      sepayFilterByAccount: settings.sepayFilterByAccount,
      larkProductRetryCronEnabled: settings.larkProductRetryCronEnabled,
      misaDictionaryCronEnabled: settings.misaDictionaryCronEnabled,
    };

    const updated = await this.prisma.settings.update({
      where: { id: settings.id },
      data: {
        managerCustomerByBranch: dto.managerCustomerByBranch,
        allowOrderWhenOutStock: dto.allowOrderWhenOutStock,
        allowSellWhenOrderOutStock: dto.allowSellWhenOrderOutStock,
        allowSellWhenOutStock: dto.allowSellWhenOutStock,
        syncKiotEnabled: dto.syncKiotEnabled,
        sepayFilterByAccount: dto.sepayFilterByAccount,
        larkProductRetryCronEnabled: dto.larkProductRetryCronEnabled,
        misaDictionaryCronEnabled: dto.misaDictionaryCronEnabled,
      },
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SETTINGS_UPDATE',
        entityType: 'settings',
        entityId: updated.id.toString(),
        entityCode: 'system_settings',
        category: getCategoryFromActionCode('SETTINGS_UPDATE'),
        severity: getSeverityFromActionCode('SETTINGS_UPDATE'),
        snapshot: { before, after: dto },
        message: renderAuditMessage('SETTINGS_UPDATE', {}),
        messageTemplate: 'SETTINGS_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
      });
    }

    return updated;
  }
}
