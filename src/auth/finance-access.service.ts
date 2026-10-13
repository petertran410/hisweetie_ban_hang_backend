import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

/** Chi nhánh có sổ tài chính nội bộ: Kho HN, Kho SG, VP HN, VP SG. */
export const FINANCE_BRANCH_IDS = [6, 1, 4, 7] as const;

const FINANCE_RESOURCES = [
  'warehouse_expense',
  'internal_fund',
  'warehouse_cash',
  'vehicles',
  'cash_flows',
];

/** Người thao tác: id, hoặc user của request (đã có vai trò và chi nhánh). */
export type FinanceActor =
  | number
  | { id: number; roles?: string[]; branchIds?: number[] };

interface ResolvedActor {
  id: number;
  superAdmin: boolean;
  branchIds: number[];
}

/**
 * Quy tắc phân quyền chung của các trang tài chính nội bộ: làm được việc X ở
 * chi nhánh B khi B nằm trong danh sách chi nhánh của user VÀ vai trò của user
 * tại B có quyền X. Super Admin làm được ở mọi chi nhánh.
 */
@Injectable()
export class FinanceAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  private async resolve(actor: FinanceActor): Promise<ResolvedActor> {
    if (
      typeof actor === 'object' &&
      Array.isArray(actor.roles) &&
      Array.isArray(actor.branchIds)
    ) {
      return {
        id: actor.id,
        superAdmin: actor.roles.includes('Super Admin'),
        branchIds: actor.branchIds.map(Number),
      };
    }
    const id = typeof actor === 'number' ? actor : actor?.id;
    const user = id
      ? await this.prisma.user.findUnique({
          where: { id },
          select: {
            branchId: true,
            userBranches: { select: { branchId: true } },
            userRoles: { select: { role: { select: { name: true } } } },
          },
        })
      : null;
    const branchIds = new Set<number>(
      (user?.userBranches || []).map((row) => row.branchId),
    );
    if (user?.branchId) branchIds.add(user.branchId);
    return {
      id: id || 0,
      superAdmin:
        user?.userRoles?.some((row) => row.role.name === 'Super Admin') ||
        false,
      branchIds: [...branchIds],
    };
  }

  private async permissionsAt(actor: ResolvedActor, branchId: number) {
    if (!actor.id || !actor.branchIds.includes(Number(branchId))) return [];
    return this.authService.getPermissionsForBranch(actor.id, Number(branchId));
  }

  async isSuperAdmin(actor: FinanceActor) {
    return (await this.resolve(actor)).superAdmin;
  }

  async can(actor: FinanceActor, branchId: number, permission: string) {
    const resolved = await this.resolve(actor);
    if (resolved.superAdmin) return true;
    return (await this.permissionsAt(resolved, branchId)).includes(permission);
  }

  async assert(actor: FinanceActor, branchId: number, permission: string) {
    if (!(await this.can(actor, branchId, permission)))
      throw new ForbiddenException(
        `Thiếu quyền ${permission} cho chi nhánh này`,
      );
  }

  /** Các chi nhánh trong `candidates` mà user có ít nhất một quyền đã nêu. */
  async branchesFor(
    actor: FinanceActor,
    permissions: string | string[],
    candidates: readonly number[] = FINANCE_BRANCH_IDS,
  ): Promise<number[]> {
    const resolved = await this.resolve(actor);
    if (resolved.superAdmin) return [...candidates];
    const wanted = Array.isArray(permissions) ? permissions : [permissions];
    const allowed: number[] = [];
    for (const branchId of candidates) {
      const granted = await this.permissionsAt(resolved, branchId);
      if (wanted.some((permission) => granted.includes(permission)))
        allowed.push(branchId);
    }
    return allowed;
  }

  /** Quyền tài chính của user tại từng chi nhánh, cho giao diện. */
  async summary(actor: FinanceActor) {
    const resolved = await this.resolve(actor);
    const branches: Array<{ branchId: number; permissions: string[] }> = [];
    for (const branchId of FINANCE_BRANCH_IDS) {
      const granted = resolved.superAdmin
        ? []
        : (await this.permissionsAt(resolved, branchId)).filter((permission) =>
            FINANCE_RESOURCES.includes(permission.split(':')[0]),
          );
      if (resolved.superAdmin || granted.length)
        branches.push({ branchId, permissions: granted });
    }
    return { superAdmin: resolved.superAdmin, branches };
  }
}
