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
    oldValues?: any;
    newValues?: any;
    changedFields?: any;
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

          oldValues: data.oldValues
            ? JSON.parse(JSON.stringify(data.oldValues))
            : undefined,
          newValues: data.newValues
            ? JSON.parse(JSON.stringify(data.newValues))
            : undefined,
          changedFields: data.changedFields,

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
    resource?: string;
    action?: string;
    method?: string;
    sessionId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const {
      userId,
      branchId,
      resource,
      action,
      method,
      sessionId,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = filters || {};

    const where: any = {};

    if (userId) where.userId = userId;
    if (branchId) where.branchId = branchId;
    if (resource) where.resource = resource;
    if (action) where.action = action;
    if (method) where.method = method;
    if (sessionId) where.sessionId = sessionId;

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
