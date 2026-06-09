import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Quyết định danh sách user nhận thông báo cho một giao dịch Sepay.
 *
 * Tôn trọng cùng quy tắc hiển thị như SepaySyncService.resolveAccountRestriction:
 *   - Settings.sepayFilterByAccount TẮT  → mọi user có quyền sepay:view.
 *   - Settings.sepayFilterByAccount BẬT  → Admin/Super Admin ∪ user có
 *     sepay:view_all ∪ user có tài khoản ngân hàng (UserBankAccount) khớp
 *     accountNumber/subAccount của giao dịch.
 *
 * Quyền được tính KHỚP với AuthService.getPermissionsForBranch nhưng gộp trên
 * MỌI chi nhánh user có vai trò: hệ thống cấp quyền chủ yếu qua role theo chi
 * nhánh (roleBranchPermissions) nên không thể chỉ đọc role global. Một user
 * coi là "có quyền xem" nếu có sepay:view (hoặc view_all) ở ÍT NHẤT một branch.
 */
@Injectable()
export class NotificationFanoutService {
  private readonly logger = new Logger(NotificationFanoutService.name);

  constructor(private prisma: PrismaService) {}

  async resolveSepayRecipients(tx: {
    accountNumber: string | null;
    subAccount: string | null;
  }): Promise<number[]> {
    const settings = await this.prisma.settings.findFirst({
      select: { sepayFilterByAccount: true },
    });
    const filterByAccount = !!settings?.sepayFilterByAccount;

    // Nạp 1 lần: user active + role global + role theo chi nhánh + grant/deny
    // + override theo chi nhánh + mapping TK ngân hàng.
    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true,
        userRoles: {
          select: {
            role: {
              select: {
                name: true,
                rolePermissions: {
                  select: {
                    permission: { select: { resource: true, action: true } },
                  },
                },
              },
            },
          },
        },
        userBranchRoles: {
          select: {
            branchId: true,
            role: {
              select: {
                name: true,
                rolePermissions: {
                  select: {
                    permission: { select: { resource: true, action: true } },
                  },
                },
                roleBranchPermissions: {
                  select: {
                    branchId: true,
                    permission: { select: { resource: true, action: true } },
                  },
                },
              },
            },
          },
        },
        userPermissions: {
          select: {
            type: true,
            permission: { select: { resource: true, action: true } },
          },
        },
        branchPermissions: {
          select: {
            granted: true,
            permission: { select: { resource: true, action: true } },
          },
        },
        bankAccountMapping: {
          select: { bankAccount: { select: { accountNumber: true } } },
        },
      },
    });

    const recipients: number[] = [];

    for (const u of users) {
      const roleNames = [
        ...u.userRoles.map((ur) => ur.role.name),
        ...u.userBranchRoles.map((ubr) => ubr.role.name),
      ];
      const isAdmin =
        roleNames.includes('Super Admin') || roleNames.includes('Admin');

      const perms = this.computePermissionKeys(u);
      const canView = perms.has('sepay:view') || perms.has('sepay:view_all');

      if (!filterByAccount) {
        // Không lọc theo TK: ai có sepay:view (hoặc view_all) đều nhận.
        if (canView || isAdmin) recipients.push(u.id);
        continue;
      }

      // Có lọc theo TK:
      if (isAdmin || perms.has('sepay:view_all')) {
        recipients.push(u.id);
        continue;
      }
      // User thường: phải có sepay:view VÀ tài khoản ngân hàng khớp giao dịch.
      if (canView) {
        const acc = u.bankAccountMapping?.bankAccount?.accountNumber ?? null;
        if (acc && this.accountMatches(acc, tx)) {
          recipients.push(u.id);
        }
      }
    }

    return recipients;
  }

  /**
   * Gộp quyền của user trên MỌI chi nhánh — mô phỏng getPermissionsForBranch
   * nhưng không giới hạn 1 branch:
   *   - base = ∪ theo từng branch role (ưu tiên roleBranchPermissions của branch
   *     đó, fallback rolePermissions) ∪ role global (rolePermissions).
   *   - cộng userPermissions(grant), trừ userPermissions(deny).
   *   - áp userBranchPermission: granted → thêm, ngược lại → bớt.
   */
  private computePermissionKeys(u: {
    userRoles: {
      role: { rolePermissions: { permission: { resource: string; action: string } }[] };
    }[];
    userBranchRoles: {
      branchId: number;
      role: {
        rolePermissions: { permission: { resource: string; action: string } }[];
        roleBranchPermissions: {
          branchId: number;
          permission: { resource: string; action: string };
        }[];
      };
    }[];
    userPermissions: { type: string; permission: { resource: string; action: string } }[];
    branchPermissions: {
      granted: boolean;
      permission: { resource: string; action: string };
    }[];
  }): Set<string> {
    const keys = new Set<string>();

    // Role theo chi nhánh: ưu tiên roleBranchPermissions của đúng branch,
    // fallback về rolePermissions của role.
    for (const ubr of u.userBranchRoles) {
      const branchPerms = ubr.role.roleBranchPermissions.filter(
        (rbp) => rbp.branchId === ubr.branchId,
      );
      const source =
        branchPerms.length > 0
          ? branchPerms.map((rbp) => rbp.permission)
          : ubr.role.rolePermissions.map((rp) => rp.permission);
      for (const perm of source) {
        keys.add(`${perm.resource}:${perm.action}`);
      }
    }

    // Role global (nếu có) — vd Super Admin.
    for (const ur of u.userRoles) {
      for (const rp of ur.role.rolePermissions) {
        keys.add(`${rp.permission.resource}:${rp.permission.action}`);
      }
    }

    // Grant/deny trực tiếp trên user.
    const deny = new Set<string>();
    for (const up of u.userPermissions) {
      const key = `${up.permission.resource}:${up.permission.action}`;
      if (up.type === 'grant') keys.add(key);
      else if (up.type === 'deny') deny.add(key);
    }
    for (const d of deny) keys.delete(d);

    // Override theo chi nhánh (UserBranchPermission).
    for (const bp of u.branchPermissions) {
      const key = `${bp.permission.resource}:${bp.permission.action}`;
      if (bp.granted) keys.add(key);
      else keys.delete(key);
    }

    return keys;
  }

  /**
   * Khớp tài khoản user với giao dịch — đối xứng buildAccountMatchClause:
   * giao dịch thuộc về acc nếu subAccount = acc, hoặc (accountNumber = acc và
   * subAccount rỗng).
   */
  private accountMatches(
    acc: string,
    tx: { accountNumber: string | null; subAccount: string | null },
  ): boolean {
    if (tx.subAccount) return tx.subAccount === acc;
    return tx.accountNumber === acc;
  }
}
