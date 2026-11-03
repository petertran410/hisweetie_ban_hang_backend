import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerGroupDto, UpdateCustomerGroupDto } from './dto';
import { CustomerGroup, Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { buildChanges } from '../audit-logs/audit-diff.utils';

// Nhóm khách hàng không bị xóa hẳn mà chỉ "hủy" (isActive = false) để giữ lại
// làm minh chứng. Mọi thay đổi được ghi vào Lịch sử thao tác (audit_logs).
@Injectable()
export class CustomerGroupsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll() {
    const groups = await this.prisma.customerGroup.findMany({
      where: { isActive: true },
      include: {
        creator: {
          select: { id: true, name: true },
        },
        customerGroupDetails: {
          include: {
            customer: {
              select: { id: true, code: true, name: true },
            },
          },
        },
        _count: {
          select: { customerGroupDetails: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      total: groups.length,
      data: groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        discount: group.discount,
        allowedUserIds: group.allowedUserIds,
        autoAddConditions: group.autoAddConditions,
        autoUpdateMode: group.autoUpdateMode,
        autoExecute: group.autoExecute,
        isActive: group.isActive,
        createdDate: group.createdAt,
        createdBy: group.createdBy,
        customerCount: group._count.customerGroupDetails,
        customerGroupDetails: group.customerGroupDetails.map((detail) => ({
          id: detail.id,
          customerId: detail.customerId,
          groupId: detail.customerGroupId,
        })),
      })),
    };
  }

  // Danh sách nhóm đã hủy (bản gọn). Ai hủy, lúc nào: xem Lịch sử thao tác.
  async findCancelled() {
    const groups = await this.prisma.customerGroup.findMany({
      where: { isActive: false },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        creator: { select: { id: true, name: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });

    return { total: groups.length, data: groups };
  }

  async findOne(id: number) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id },
      include: {
        creator: {
          select: { id: true, name: true },
        },
        customerGroupDetails: {
          include: {
            customer: {
              select: { id: true, code: true, name: true, contactNumber: true },
            },
          },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Customer group with id ${id} not found`);
    }

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      discount: group.discount,
      allowedUserIds: group.allowedUserIds,
      autoAddConditions: group.autoAddConditions,
      autoUpdateMode: group.autoUpdateMode,
      autoExecute: group.autoExecute,
      isActive: group.isActive,
      createdDate: group.createdAt,
      createdBy: group.createdBy,
      customerGroupDetails: group.customerGroupDetails.map((detail) => ({
        id: detail.id,
        customerId: detail.customerId,
        groupId: detail.customerGroupId,
        customer: detail.customer,
      })),
    };
  }

  async create(dto: CreateCustomerGroupDto, userId?: number) {
    const group = await this.prisma.customerGroup.create({
      data: {
        name: dto.name,
        description: dto.description,
        discount: dto.discount,
        allowedUserIds: dto.allowedUserIds || [],
        autoAddConditions: dto.autoAddConditions
          ? (dto.autoAddConditions as Prisma.InputJsonValue)
          : undefined,
        autoUpdateMode: dto.autoUpdateMode || undefined,
        autoExecute: dto.autoExecute || false,
        createdBy: userId,
      },
      include: {
        creator: {
          select: { id: true, name: true },
        },
      },
    });

    await this.logAction('CUSTOMER_GROUP_CREATE', 'POST', group, userId, {
      snapshot: this.buildSnapshot(group),
    });

    return group;
  }

  async update(id: number, dto: UpdateCustomerGroupDto, userId?: number) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id },
    });

    if (!group) {
      throw new NotFoundException(`Customer group with id ${id} not found`);
    }

    const updated = await this.prisma.customerGroup.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        discount: dto.discount,
        allowedUserIds: dto.allowedUserIds,
        // Sử dụng undefined thay vì null cho Json field
        autoAddConditions: dto.autoAddConditions
          ? (dto.autoAddConditions as Prisma.InputJsonValue)
          : undefined,
        autoUpdateMode: dto.autoUpdateMode || undefined,
        autoExecute: dto.autoExecute,
      },
      include: {
        creator: {
          select: { id: true, name: true },
        },
      },
    });

    await this.logAction('CUSTOMER_GROUP_UPDATE', 'PUT', updated, userId, {
      changes: buildChanges(
        'customer_groups',
        this.buildSnapshot(group),
        this.buildSnapshot(updated),
      ),
      snapshot: this.buildSnapshot(updated),
    });

    return updated;
  }

  async checkUserAccess(groupId: number, userId: number): Promise<boolean> {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id: groupId },
      select: { allowedUserIds: true },
    });

    if (!group) return false;
    if (group.allowedUserIds.length === 0) return true;
    return group.allowedUserIds.includes(userId);
  }

  /**
   * Hủy nhóm (không xóa hẳn). Nhóm còn khách thì chỉ hủy được khi
   * `removeCustomers` = true (gỡ hết khách khỏi nhóm, khách vẫn giữ nguyên).
   * Không cho hủy khi nhóm đang gắn vào bảng giá / khuyến mãi đang hoạt động.
   */
  async cancel(id: number, userId?: number, removeCustomers = false) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id },
      include: {
        customerGroupDetails: {
          select: {
            customer: { select: { id: true, code: true, name: true } },
          },
        },
        priceBookCustomerGroups: {
          where: { priceBook: { isActive: true } },
          select: { priceBook: { select: { name: true } } },
        },
        promotionCustomerGroups: {
          where: { promotion: { isActive: true } },
          select: { promotion: { select: { name: true } } },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Customer group with id ${id} not found`);
    }
    if (!group.isActive) {
      throw new BadRequestException(
        `Nhóm "${group.name}" đã được hủy trước đó`,
      );
    }

    const customers = group.customerGroupDetails.map((d) => d.customer);
    if (customers.length > 0 && !removeCustomers) {
      throw new BadRequestException(
        `Không thể hủy nhóm "${group.name}" vì còn ${customers.length} khách hàng. Hãy gỡ hết khách khỏi nhóm trước.`,
      );
    }

    const usedBy = [
      ...group.priceBookCustomerGroups.map(
        (p) => `bảng giá "${p.priceBook.name}"`,
      ),
      ...group.promotionCustomerGroups.map(
        (p) => `khuyến mãi "${p.promotion.name}"`,
      ),
    ];
    if (usedBy.length > 0) {
      throw new BadRequestException(
        `Không thể hủy nhóm "${group.name}" vì đang dùng trong ${usedBy.join(', ')}. Hãy bỏ nhóm khỏi đó trước.`,
      );
    }

    const cancelled = await this.prisma.$transaction(async (tx) => {
      if (customers.length > 0) {
        await tx.customerGroupDetail.deleteMany({
          where: { customerGroupId: id },
        });
      }
      return tx.customerGroup.update({
        where: { id },
        data: { isActive: false },
      });
    });

    await this.logAction('CUSTOMER_GROUP_CANCEL', 'POST', cancelled, userId, {
      params: { customerCount: customers.length },
      // Giữ danh sách khách đã gỡ làm bằng chứng
      snapshot: { ...this.buildSnapshot(group), removedCustomers: customers },
    });

    return {
      message: `Đã hủy nhóm khách hàng "${group.name}"`,
      removedCustomers: customers.length,
    };
  }

  async restore(id: number, userId?: number) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id },
    });

    if (!group) {
      throw new NotFoundException(`Customer group with id ${id} not found`);
    }
    if (group.isActive) {
      throw new BadRequestException(`Nhóm "${group.name}" đang hoạt động`);
    }

    const restored = await this.prisma.customerGroup.update({
      where: { id },
      data: { isActive: true },
    });

    await this.logAction('CUSTOMER_GROUP_RESTORE', 'POST', restored, userId, {
      snapshot: this.buildSnapshot(restored),
    });

    return { message: `Đã khôi phục nhóm khách hàng "${group.name}"` };
  }

  async addCustomersToGroup(
    groupId: number,
    customerIds: number[],
    userId?: number,
  ) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException(
        `Customer group with id ${groupId} not found`,
      );
    }
    if (!group.isActive) {
      throw new BadRequestException(
        `Nhóm "${group.name}" đã hủy, không thể thêm khách`,
      );
    }

    const result = await this.prisma.customerGroupDetail.createMany({
      data: customerIds.map((customerId) => ({
        customerGroupId: groupId,
        customerId,
      })),
      skipDuplicates: true,
    });

    if (result.count > 0) {
      await this.logAction(
        'CUSTOMER_GROUP_ADD_CUSTOMERS',
        'POST',
        group,
        userId,
        {
          params: { customerCount: result.count },
          snapshot: { customerIds },
        },
      );
    }

    return { message: 'Thêm khách hàng vào nhóm thành công' };
  }

  async removeCustomersFromGroup(
    groupId: number,
    customerIds: number[],
    userId?: number,
  ) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException(
        `Customer group with id ${groupId} not found`,
      );
    }

    const result = await this.prisma.customerGroupDetail.deleteMany({
      where: {
        customerGroupId: groupId,
        customerId: { in: customerIds },
      },
    });

    if (result.count > 0) {
      await this.logAction(
        'CUSTOMER_GROUP_REMOVE_CUSTOMERS',
        'POST',
        group,
        userId,
        {
          params: { customerCount: result.count },
          snapshot: { customerIds },
        },
      );
    }

    return { message: 'Xóa khách hàng khỏi nhóm thành công' };
  }

  private buildSnapshot(group: CustomerGroup) {
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      discount: group.discount == null ? null : Number(group.discount),
      allowedUserIds: group.allowedUserIds,
      autoAddConditions: group.autoAddConditions,
      autoUpdateMode: group.autoUpdateMode,
      autoExecute: group.autoExecute,
      isActive: group.isActive,
    };
  }

  // Ghi Lịch sử thao tác cho nhóm khách hàng (bỏ qua khi không có người dùng).
  private async logAction(
    actionCode: string,
    actionType: string,
    group: CustomerGroup,
    userId: number | undefined,
    extra: {
      params?: Record<string, string | number>;
      snapshot?: unknown;
      changes?: unknown;
    } = {},
  ) {
    if (!userId) return;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, branchId: true },
    });

    await this.auditLogsService.create({
      actionType,
      actionCode,
      entityType: 'customer_groups',
      entityId: group.id.toString(),
      entityCode: group.name,
      category: getCategoryFromActionCode(actionCode),
      severity: getSeverityFromActionCode(actionCode),
      snapshot: extra.snapshot,
      changes: extra.changes,
      message: renderAuditMessage(actionCode, {
        groupName: group.name,
        ...extra.params,
      }),
      messageTemplate: actionCode,
      messageParams: { groupName: group.name, ...extra.params },
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: user?.branchId || undefined,
    });
  }
}
