import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma, PriceChangeTicket } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';
import {
  APPLY_LOCK_MS,
  BASE_PRICE_BOOK_ID,
  PC_ACTION,
  PC_EVENT,
  PC_STAGE,
  PC_STATUS,
} from './price-change.constants';
import { resolveAccess } from './price-change.rules';
import { PriceChangeConfigService } from './price-change-config.service';
import {
  CurrentValueRow,
  PriceChangeReferenceService,
} from './price-change-reference.service';
import { PriceChangeNotifyService } from './price-change-notify.service';
import { PcUser, PriceChangeService, parseItem } from './price-change.service';

export interface ApplyIssue {
  severity: 'error' | 'warning';
  message: string;
  productCode?: string;
}

export interface ApplyCell {
  kind: 'COST' | 'PRICE';
  /** branchId (COST) hoặc priceBookId (PRICE, 0 = Bảng giá chung). */
  targetId: number;
  targetName: string;
  oldValue: number | null;
  currentValue: number | null;
  newValue: number;
  /** Giá trên POS đã khác giá lúc đề xuất. */
  changedSinceProposal: boolean;
  /** Chưa có dòng tồn kho / chưa có trong bảng giá → sẽ tạo mới. */
  createsRow: boolean;
}

export interface ApplyRow {
  itemId: number;
  productId: number | null;
  productCode: string;
  productName: string;
  cells: ApplyCell[];
}

export interface ApplyPreview {
  ok: boolean;
  issues: ApplyIssue[];
  rows: ApplyRow[];
  counts: { products: number; costCells: number; priceCells: number };
}

type PlanItem = ReturnType<typeof parseItem>;

const sameMoney = (a: number | null, b: number | null) =>
  a === b || (a !== null && b !== null && Math.abs(a - b) < 0.005);

/**
 * Kế hoạch áp dụng (hàm thuần): ô nào ghi giá gì, lỗi chặn + cảnh báo.
 * `current` = giá đang có trên POS; branchIds / priceBookIds = chi nhánh / bảng giá còn hoạt động.
 */
export function buildApplyPlan(
  items: PlanItem[],
  current: CurrentValueRow[],
  activeBranchIds: Set<number>,
  activePriceBookIds: Set<number>,
): ApplyPreview {
  const issues: ApplyIssue[] = [];
  const byId = new Map(current.map((c) => [c.productId, c]));
  const rows: ApplyRow[] = [];
  let costCells = 0;
  let priceCells = 0;
  const missingBranches = new Set<string>();
  const missingBooks = new Set<string>();

  for (const item of items) {
    const code = item.productCode;
    const cur = item.productId !== null ? byId.get(item.productId) : undefined;
    if (item.productId === null) {
      issues.push({
        severity: 'error',
        productCode: code,
        message: `${code}: chưa khớp sản phẩm trên POS`,
      });
    } else if (!cur) {
      issues.push({
        severity: 'error',
        productCode: code,
        message: `${code}: sản phẩm không còn trên POS`,
      });
    } else if (!cur.isActive) {
      issues.push({
        severity: 'error',
        productCode: code,
        message: `${code}: sản phẩm đã ngừng kinh doanh`,
      });
    }

    const cells: ApplyCell[] = [];
    for (const c of item.costs) {
      if (c.newCost === null) continue;
      if (!activeBranchIds.has(c.branchId)) missingBranches.add(c.branchName);
      const currentValue = cur ? (cur.costs[c.branchId] ?? null) : null;
      cells.push({
        kind: 'COST',
        targetId: c.branchId,
        targetName: c.branchName,
        oldValue: c.oldCost,
        currentValue,
        newValue: c.newCost,
        changedSinceProposal: !!cur && !sameMoney(c.oldCost, currentValue),
        createsRow: !!cur && currentValue === null,
      });
    }
    for (const p of item.prices) {
      if (p.newPrice === null) continue;
      if (
        p.priceBookId !== BASE_PRICE_BOOK_ID &&
        !activePriceBookIds.has(p.priceBookId)
      ) {
        missingBooks.add(p.priceBookName);
      }
      const currentValue = cur ? (cur.prices[p.priceBookId] ?? null) : null;
      cells.push({
        kind: 'PRICE',
        targetId: p.priceBookId,
        targetName: p.priceBookName,
        oldValue: p.oldPrice,
        currentValue,
        newValue: p.newPrice,
        changedSinceProposal: !!cur && !sameMoney(p.oldPrice, currentValue),
        createsRow: !!cur && currentValue === null,
      });
    }
    costCells += cells.filter((c) => c.kind === 'COST').length;
    priceCells += cells.filter((c) => c.kind === 'PRICE').length;

    const changed = cells.filter((c) => c.changedSinceProposal);
    if (changed.length) {
      issues.push({
        severity: 'warning',
        productCode: code,
        message: `${code}: giá hiện tại đã khác lúc đề xuất (${changed
          .map((c) => c.targetName)
          .join(', ')})`,
      });
    }
    const newInv = cells.filter((c) => c.createsRow && c.kind === 'COST');
    if (newInv.length) {
      issues.push({
        severity: 'warning',
        productCode: code,
        message: `${code}: chưa có dòng tồn kho tại ${newInv
          .map((c) => c.targetName)
          .join(', ')} — sẽ tạo mới (tồn 0)`,
      });
    }
    if (
      cur &&
      [1, 4].includes(cur.type) &&
      cells.some((c) => c.kind === 'COST')
    ) {
      issues.push({
        severity: 'warning',
        productCode: code,
        message: `${code}: hàng combo / sản xuất — giá vốn có thể bị tính lại từ thành phần khi sửa hàng hóa`,
      });
    }
    if (!cells.length) {
      issues.push({
        severity: 'error',
        productCode: code,
        message: `${code}: không có giá mới nào`,
      });
    }

    rows.push({
      itemId: item.id,
      productId: item.productId,
      productCode: code,
      productName: item.productName,
      cells,
    });
  }

  for (const name of missingBranches) {
    issues.push({
      severity: 'error',
      message: `Chi nhánh "${name}" không còn hoạt động`,
    });
  }
  for (const name of missingBooks) {
    issues.push({
      severity: 'error',
      message: `Bảng giá "${name}" không còn hoạt động`,
    });
  }
  if (!items.length)
    issues.push({ severity: 'error', message: 'Phiếu không có sản phẩm nào' });

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    rows,
    counts: { products: rows.length, costCells, priceCells },
  };
}

interface AppliedChange {
  kind: 'COST' | 'PRICE';
  targetId: number;
  targetName: string;
  before: number | null;
  after: number;
}

/** "Áp dụng thay đổi giá" ở bước Phòng Dữ Liệu. */
@Injectable()
export class PriceChangeApplyService {
  private readonly logger = new Logger(PriceChangeApplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly pcConfig: PriceChangeConfigService,
    private readonly reference: PriceChangeReferenceService,
    private readonly larkProductSync: LarkProductSyncService,
    private readonly notify: PriceChangeNotifyService,
    private readonly service: PriceChangeService,
  ) {}

  async preview(id: number): Promise<ApplyPreview> {
    const ticket = await this.service.getTicketOrThrow(id);
    return this.buildPreview(ticket);
  }

  private async buildPreview(
    ticket: PriceChangeTicket,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<ApplyPreview> {
    const items = await this.service.getItems(ticket.id, db);
    const branchIds = [
      ...new Set(items.flatMap((i) => i.costs.map((c) => c.branchId))),
    ];
    const bookIds = [
      ...new Set(items.flatMap((i) => i.prices.map((p) => p.priceBookId))),
    ];
    const productIds = items
      .map((i) => i.productId)
      .filter((id): id is number => id !== null);
    const [current, branches, books] = await Promise.all([
      this.reference.currentValues(productIds, branchIds, bookIds, db),
      db.branch.findMany({
        where: { id: { in: branchIds }, isActive: true },
        select: { id: true },
      }),
      db.priceBook.findMany({
        where: { id: { in: bookIds }, isActive: true },
        select: { id: true },
      }),
    ]);
    return buildApplyPlan(
      items,
      current,
      new Set(branches.map((b) => b.id)),
      new Set(books.map((b) => b.id)),
    );
  }

  async apply(id: number, user: PcUser) {
    const [ticket, cfg] = await Promise.all([
      this.service.getTicketOrThrow(id),
      this.pcConfig.get(),
    ]);
    const access = resolveAccess(
      ticket,
      this.service.actorOf(user),
      cfg.approvers,
    );
    if (!access.actions.includes(PC_ACTION.APPLY)) {
      throw new ForbiddenException(
        'Bạn không có quyền áp dụng thay đổi giá cho phiếu này',
      );
    }
    const check = await this.buildPreview(ticket);
    if (!check.ok) {
      throw new BadRequestException(
        `Chưa thể áp dụng: ${check.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .slice(0, 5)
          .join('; ')}`,
      );
    }

    // Giành phiếu (chống 2 người bấm cùng lúc); khóa tự hết hạn nếu máy chủ chết giữa chừng.
    const now = new Date();
    const claim = await this.prisma.priceChangeTicket.updateMany({
      where: {
        id,
        stage: PC_STAGE.DATA,
        OR: [
          { applyStartedAt: null },
          { applyStartedAt: { lt: new Date(now.getTime() - APPLY_LOCK_MS) } },
        ],
      },
      data: { applyStartedAt: now },
    });
    if (claim.count !== 1) {
      throw new ConflictException(
        'Phiếu đang được áp dụng hoặc đã thay đổi, vui lòng tải lại',
      );
    }

    let applied: {
      productId: number;
      code: string;
      name: string;
      changes: AppliedChange[];
    }[];
    try {
      applied = await this.prisma.$transaction(
        async (tx) => {
          const productIds = check.rows
            .map((r) => r.productId)
            .filter((x): x is number => x !== null);
          const branchIds = [
            ...new Set(
              check.rows.flatMap((r) =>
                r.cells.filter((c) => c.kind === 'COST').map((c) => c.targetId),
              ),
            ),
          ];
          // Khóa các dòng sẽ ghi để giá "trước" trong audit đúng với giá bị ghi đè.
          if (productIds.length) {
            await tx.$queryRaw`SELECT id FROM products WHERE id IN (${Prisma.join(productIds)}) FOR UPDATE`;
          }
          if (productIds.length && branchIds.length) {
            await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" IN (${Prisma.join(productIds)}) AND "branchId" IN (${Prisma.join(branchIds)}) FOR UPDATE`;
          }
          const plan = await this.buildPreview(ticket, tx);
          if (!plan.ok) {
            throw new BadRequestException(
              'Dữ liệu đã thay đổi, vui lòng mở lại bản xem trước',
            );
          }

          const branchNames = new Map(
            (
              await tx.branch.findMany({
                where: { id: { in: branchIds } },
                select: { id: true, name: true },
              })
            ).map((b) => [b.id, b.name]),
          );

          const result: typeof applied = [];
          for (const row of plan.rows) {
            const productId = row.productId!;
            const changes: AppliedChange[] = [];
            for (const cell of row.cells) {
              const value = new Prisma.Decimal(cell.newValue);
              if (cell.kind === 'COST') {
                await tx.inventory.upsert({
                  where: {
                    productId_branchId: { productId, branchId: cell.targetId },
                  },
                  update: { cost: value },
                  create: {
                    productId,
                    productCode: row.productCode,
                    productName: row.productName,
                    branchId: cell.targetId,
                    branchName:
                      branchNames.get(cell.targetId) ?? cell.targetName,
                    cost: value,
                  },
                });
              } else if (cell.targetId === BASE_PRICE_BOOK_ID) {
                await tx.product.update({
                  where: { id: productId },
                  data: { basePrice: value },
                });
              } else {
                await tx.priceBookDetail.upsert({
                  where: {
                    priceBookId_productId: {
                      priceBookId: cell.targetId,
                      productId,
                    },
                  },
                  update: { price: value, isActive: true },
                  create: {
                    priceBookId: cell.targetId,
                    productId,
                    price: value,
                    isActive: true,
                  },
                });
              }
              changes.push({
                kind: cell.kind,
                targetId: cell.targetId,
                targetName: cell.targetName,
                before: cell.currentValue,
                after: cell.newValue,
              });
            }
            result.push({
              productId,
              code: row.productCode,
              name: row.productName,
              changes,
            });
          }

          const doneAt = new Date();
          const summary = {
            at: doneAt.toISOString(),
            products: result.length,
            costCells: plan.counts.costCells,
            priceCells: plan.counts.priceCells,
            rows: result,
          };
          const res = await tx.priceChangeTicket.updateMany({
            where: { id, stage: PC_STAGE.DATA },
            data: {
              stage: PC_STAGE.DONE,
              status: PC_STATUS.APPROVED,
              stageEnteredAt: doneAt,
              doneAt,
              appliedAt: doneAt,
              appliedById: user.id,
              appliedByName: user.name ?? null,
              applyStartedAt: null,
              applyResult: summary as unknown as Prisma.InputJsonValue,
              updatedById: user.id,
              updatedByName: user.name ?? null,
            },
          });
          if (res.count !== 1) {
            throw new ConflictException(
              'Phiếu đã được cập nhật, vui lòng tải lại',
            );
          }
          await tx.priceChangeEvent.create({
            data: {
              ticketId: id,
              type: PC_EVENT.APPLIED,
              fromStage: PC_STAGE.DATA,
              toStage: PC_STAGE.DONE,
              data: {
                products: result.length,
                costCells: plan.counts.costCells,
                priceCells: plan.counts.priceCells,
              },
              actorId: user.id,
              actorName: user.name ?? null,
            },
          });
          return result;
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
    } catch (err) {
      await this.prisma.priceChangeTicket
        .updateMany({
          where: { id, stage: PC_STAGE.DATA },
          data: { applyStartedAt: null },
        })
        .catch(() => undefined);
      throw err;
    }

    // Sau commit: audit từng sản phẩm (lịch sử giá), đồng bộ Lark, báo người đề xuất.
    for (const p of applied) {
      void this.auditLogs
        .create({
          actionType: 'PUT',
          actionCode: 'PRICE_CHANGE_APPLY',
          entityType: 'products',
          entityId: String(p.productId),
          entityCode: p.code,
          category: 'Sản phẩm',
          severity: 'info',
          changes: p.changes.map((c) => ({
            field:
              c.kind === 'COST'
                ? `cost_branch_${c.targetId}`
                : `price_book_${c.targetId}`,
            label:
              c.kind === 'COST'
                ? `Giá vốn — ${c.targetName}`
                : `Giá — ${c.targetName}`,
            from: c.before,
            to: c.after,
            type: 'field_changed',
          })),
          message: `Áp dụng phiếu thay đổi giá ${ticket.code} cho ${p.code} — ${p.name}`,
          userId: user.id,
          userName: user.name || 'Nhân viên',
        })
        .catch((err) => this.logger.warn(`Ghi audit lỗi: ${err?.message}`));
      this.larkProductSync.enqueueSync(p.productId);
    }
    this.service.audit(
      ticket,
      user,
      'price_change.apply',
      `Áp dụng phiếu thay đổi giá ${ticket.code} (${applied.length} sản phẩm)`,
    );
    this.notify.send('APPLIED', id, {
      actorId: user.id,
      decidedByName: user.name,
      decidedByRole: 'Phòng Dữ Liệu',
    });
    return this.service.findOne(id, user);
  }
}
