import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditLogsService {
  constructor(private prisma: PrismaService) {}

  async create(data: {
    actionType: string;
    actionCode: string;
    entityType: string;
    entityId?: string;
    entityCode?: string;
    category?: string;
    severity?: string;
    snapshot?: any;
    changes?: any;
    message: string;
    messageTemplate?: string;
    messageParams?: any;
    userId: number;
    userName: string;
    branchId?: number;
    branchName?: string;
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
    metadata?: any;
  }) {
    try {
      return await this.prisma.auditLog.create({
        data: {
          actionType: data.actionType,
          actionCode: data.actionCode,
          entityType: data.entityType,
          entityId: data.entityId,
          entityCode: data.entityCode,
          category: data.category,
          severity: data.severity || 'info',

          snapshot: data.snapshot
            ? JSON.parse(JSON.stringify(data.snapshot))
            : undefined,
          changes: data.changes
            ? JSON.parse(JSON.stringify(data.changes))
            : undefined,

          message: data.message,
          messageTemplate: data.messageTemplate,
          messageParams: data.messageParams,

          userId: data.userId,
          userName: data.userName,
          branchId: data.branchId,
          branchName: data.branchName,

          ipAddress: data.ipAddress,
          userAgent: data.userAgent,
          requestId: data.requestId,

          metadata: data.metadata,
        },
      });
    } catch (error) {
      console.error('Failed to create audit log:', error);
      return null;
    }
  }

  async findAll(filters?: {
    userId?: number;
    branchId?: number;
    entityType?: string;
    actionCode?: string;
    category?: string;
    severity?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const {
      userId,
      branchId,
      entityType,
      actionCode,
      category,
      severity,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = filters || {};

    const where: any = {};

    if (userId) where.userId = userId;
    if (branchId) where.branchId = branchId;
    if (entityType) where.entityType = entityType;
    if (actionCode) where.actionCode = actionCode;
    if (category) where.category = category;
    if (severity) where.severity = severity;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          branch: { select: { id: true, name: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async deleteOldLogs(months: number = 6) {
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - months);

    return await this.prisma.auditLog.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
      },
    });
  }
}
