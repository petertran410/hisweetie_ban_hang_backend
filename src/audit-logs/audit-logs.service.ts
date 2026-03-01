import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditLogsService {
  constructor(private prisma: PrismaService) {}

  async create(data: {
    userId: number;
    userName: string;
    branchId?: number | null;
    action: string;
    resource: string;
    resourceId?: number | null;
    method?: string | null;
    path?: string | null;
    statusCode?: number | null;
    duration?: number | null;
    oldData?: any;
    newData?: any;
    metadata?: any;
    error?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    sessionId?: string | null;
  }) {
    try {
      return await this.prisma.auditLog.create({
        data: {
          userId: data.userId,
          userName: data.userName,
          branchId: data.branchId || undefined,
          action: data.action,
          resource: data.resource,
          resourceId: data.resourceId || undefined,
          method: data.method || undefined,
          path: data.path || undefined,
          statusCode: data.statusCode || undefined,
          duration: data.duration || undefined,
          oldData: data.oldData
            ? JSON.parse(JSON.stringify(data.oldData))
            : undefined,
          newData: data.newData
            ? JSON.parse(JSON.stringify(data.newData))
            : undefined,
          metadata: data.metadata
            ? JSON.parse(JSON.stringify(data.metadata))
            : undefined,
          error: data.error || undefined,
          ipAddress: data.ipAddress || undefined,
          userAgent: data.userAgent || undefined,
          sessionId: data.sessionId || undefined,
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
