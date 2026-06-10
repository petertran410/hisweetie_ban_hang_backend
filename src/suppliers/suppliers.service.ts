import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSupplierDto, UpdateSupplierDto, SupplierQueryDto } from './dto';
import { Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges } from '../audit-logs/audit-diff.utils';
import { ImportSupplierBalanceAdjustmentsDto } from './dto/import-supplier-balance-adjustment.dto';
import { recalcSupplierDebt } from '../common/supplier-debt.util';
import {
  SUPPLIER_DEBT_PO_WHERE,
  SUPPLIER_DEBT_SR_WHERE,
  SUPPLIER_DEBT_CASHFLOW_PAID_EXCLUDE_PREFIX,
  supplierPoDebtAmount,
  supplierReturnOffsetAmount,
} from '../common/supplier-debt.util';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';

@Injectable()
export class SuppliersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: SupplierQueryDto) {
    const {
      code,
      name,
      contactNumber,
      pageSize = 15,
      currentItem = 0,
      orderBy = 'createdAt',
      orderDirection = 'desc',
      groupId,
      branchId,
      createdDateFrom,
      createdDateTo,
      totalInvoicedFrom,
      totalInvoicedTo,
      debtFrom,
      debtTo,
      isActive,
      includeSupplierGroup,
    } = query;

    const where: Prisma.SupplierWhereInput = {};

    if (code) {
      where.code = { contains: code, mode: 'insensitive' };
    }

    if (name) {
      where.name = { contains: name, mode: 'insensitive' };
    }

    if (contactNumber) {
      where.OR = [
        { contactNumber: { contains: contactNumber, mode: 'insensitive' } },
      ];
    }

    if (groupId) {
      where.supplierGroupDetails = {
        some: {
          supplierGroupId: groupId,
        },
      };
    }

    if (branchId) {
      where.branchId = branchId;
    }

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) {
        where.createdAt.gte = new Date(createdDateFrom);
      }
      if (createdDateTo) {
        where.createdAt.lte = new Date(createdDateTo);
      }
    }

    if (totalInvoicedFrom !== undefined || totalInvoicedTo !== undefined) {
      where.totalInvoiced = {};
      if (totalInvoicedFrom !== undefined) {
        where.totalInvoiced.gte = totalInvoicedFrom;
      }
      if (totalInvoicedTo !== undefined) {
        where.totalInvoiced.lte = totalInvoicedTo;
      }
    }

    if (debtFrom !== undefined || debtTo !== undefined) {
      where.debt = {};
      if (debtFrom !== undefined) {
        where.debt.gte = debtFrom;
      }
      if (debtTo !== undefined) {
        where.debt.lte = debtTo;
      }
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [data, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        orderBy: { [orderBy]: orderDirection },
        include: includeSupplierGroup
          ? {
              supplierGroupDetails: {
                include: {
                  supplierGroup: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
              creator: {
                select: {
                  id: true,
                  name: true,
                },
              },
              branch: {
                select: {
                  id: true,
                  name: true,
                },
              },
            }
          : {
              creator: {
                select: {
                  id: true,
                  name: true,
                },
              },
              branch: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return {
      data,
      total,
      pageSize,
      currentItem,
    };
  }

  async findOne(id: number) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        supplierGroupDetails: {
          include: {
            supplierGroup: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        purchaseOrders: {
          orderBy: { purchaseDate: 'desc' },
          take: 10,
          include: {
            branch: true,
          },
        },
      },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with id ${id} not found`);
    }

    return supplier;
  }

  async findByCode(code: string) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { code },
      include: {
        supplierGroupDetails: {
          include: {
            supplierGroup: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with code ${code} not found`);
    }

    return supplier;
  }

  async create(
    dto: CreateSupplierDto,
    userId: number,
    branchId: number | null,
  ) {
    const { groupIds, ...supplierData } = dto;

    return this.prisma.$transaction(async (prisma) => {
      const code = await this.generateSafeSupplierCode(prisma);

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      const groupNames =
        groupIds && groupIds.length > 0
          ? await prisma.supplierGroup
              .findMany({
                where: { id: { in: groupIds } },
                select: { name: true },
              })
              .then((groups) => groups.map((g) => g.name).join('|'))
          : null;

      const supplier = await prisma.supplier.create({
        data: {
          ...supplierData,
          code,
          createdBy: userId,
          createdName: user?.name || 'Unknown',
          branchId: branchId,
          groups: groupNames,
        },
        include: {
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (groupIds && groupIds.length > 0) {
        await prisma.supplierGroupDetail.createMany({
          data: groupIds.map((groupId) => ({
            supplierId: supplier.id,
            supplierGroupId: groupId,
          })),
          skipDuplicates: true,
        });
      }

      const finalSupplier = await prisma.supplier.findUnique({
        where: { id: supplier.id },
        include: {
          supplierGroupDetails: { include: { supplierGroup: true } },
          creator: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
          purchaseOrders: {
            orderBy: { purchaseDate: 'desc' },
            take: 10,
            include: { branch: true },
          },
        },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'SUPPLIER_CREATE',
        entityType: 'suppliers',
        entityId: supplier.id.toString(),
        entityCode: supplier.code || '',
        category: getCategoryFromActionCode('SUPPLIER_CREATE'),
        severity: getSeverityFromActionCode('SUPPLIER_CREATE'),
        snapshot: this.buildSupplierSnapshot(supplier),
        message: renderAuditMessage('SUPPLIER_CREATE', {
          supplierName: supplier.name,
          supplierCode: supplier.code,
        }),
        messageTemplate: 'SUPPLIER_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });

      return finalSupplier;

      return prisma.supplier.findUnique({
        where: { id: supplier.id },
        include: {
          supplierGroupDetails: {
            include: {
              supplierGroup: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
          purchaseOrders: {
            orderBy: { purchaseDate: 'desc' },
            take: 10,
            include: {
              branch: true,
            },
          },
        },
      });
    });
  }

  async update(id: number, dto: UpdateSupplierDto, userId?: number) {
    const existingSupplier = await this.prisma.supplier.findUnique({
      where: { id },
    });

    if (!existingSupplier) {
      throw new NotFoundException(`Supplier with id ${id} not found`);
    }

    const { groupIds, ...supplierData } = dto;

    const result = await this.prisma.$transaction(async (prisma) => {
      const groupNames =
        groupIds !== undefined && groupIds.length > 0
          ? await prisma.supplierGroup
              .findMany({
                where: { id: { in: groupIds } },
                select: { name: true },
              })
              .then((groups) => groups.map((g) => g.name).join('|'))
          : null;

      const updated = await prisma.supplier.update({
        where: { id },
        data: {
          ...supplierData,
          groups: groupNames,
        },
      });

      if (groupIds !== undefined) {
        await prisma.supplierGroupDetail.deleteMany({
          where: { supplierId: id },
        });

        if (groupIds.length > 0) {
          await prisma.supplierGroupDetail.createMany({
            data: groupIds.map((groupId) => ({
              supplierId: id,
              supplierGroupId: groupId,
            })),
            skipDuplicates: true,
          });
        }
      }

      return this.findOne(updated.id);
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      const changes = buildChanges(
        'suppliers',
        {
          name: existingSupplier.name,
          contactNumber: existingSupplier.contactNumber,
          email: existingSupplier.email,
          address: existingSupplier.address,
          taxCode: existingSupplier.taxCode,
        },
        {
          name: result.name,
          contactNumber: result.contactNumber,
          email: result.email,
          address: result.address,
          taxCode: result.taxCode,
        },
      );

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SUPPLIER_UPDATE',
        entityType: 'suppliers',
        entityId: id.toString(),
        entityCode: result.code || '',
        category: getCategoryFromActionCode('SUPPLIER_UPDATE'),
        severity: getSeverityFromActionCode('SUPPLIER_UPDATE'),
        snapshot: this.buildSupplierSnapshot(result),
        changes: changes.length > 0 ? changes : null,
        message: renderAuditMessage('SUPPLIER_UPDATE', {
          supplierName: result.name,
          supplierCode: result.code,
        }),
        messageTemplate: 'SUPPLIER_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });
    }

    return result;
  }

  async remove(id: number, userId?: number) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        _count: { select: { purchaseOrders: true } },
      },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with id ${id} not found`);
    }

    if (supplier._count.purchaseOrders > 0) {
      throw new Error('Không thể xóa nhà cung cấp đã có phiếu nhập hàng');
    }

    await this.prisma.supplier.delete({ where: { id } });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'SUPPLIER_DELETE',
        entityType: 'suppliers',
        entityId: id.toString(),
        entityCode: supplier.code || '',
        category: getCategoryFromActionCode('SUPPLIER_DELETE'),
        severity: getSeverityFromActionCode('SUPPLIER_DELETE'),
        snapshot: this.buildSupplierSnapshot(supplier),
        message: renderAuditMessage('SUPPLIER_DELETE', {
          supplierName: supplier.name,
          supplierCode: supplier.code,
        }),
        messageTemplate: 'SUPPLIER_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });
    }

    return { message: 'Xóa nhà cung cấp thành công' };
  }

  async updateDebt(supplierId: number) {
    return this.prisma.$transaction((tx) => recalcSupplierDebt(tx, supplierId));
  }

  private async generateSafeSupplierCode(tx: any): Promise<string> {
    const prefix = 'NCC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allSuppliers = await tx.supplier.findMany({
        where: {
          code: { startsWith: prefix },
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allSuppliers
        .map((sup: any) => sup.code)
        .filter((code: string) => regex.test(code))
        .sort((a: string, b: string) => {
          const numA = parseInt(a.replace(prefix, ''));
          const numB = parseInt(b.replace(prefix, ''));
          return numB - numA;
        });

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const exists = await tx.supplier.findFirst({ where: { code } });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã nhà cung cấp duy nhất');
  }

  private buildSupplierSnapshot(supplier: any) {
    return {
      code: supplier.code,
      name: supplier.name,
      contactNumber: supplier.contactNumber,
      email: supplier.email,
      address: supplier.address,
      taxCode: supplier.taxCode,
      groups: supplier.groups,
      debt: supplier.debt ? Number(supplier.debt) : 0,
      totalInvoiced: supplier.totalInvoiced
        ? Number(supplier.totalInvoiced)
        : 0,
      branch: supplier.branch ? { name: supplier.branch.name } : null,
      creator: supplier.creator ? { name: supplier.creator.name } : null,
    };
  }

  async getDebtTimeline(supplierId: number) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, debt: true },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with id ${supplierId} not found`);
    }

    const timeline: any[] = [];

    // 1. Lấy purchase orders → cộng nợ.
    //    Dùng SUPPLIER_DEBT_PO_WHERE — CÙNG filter với Formula B
    //    (recalcSupplierDebt) để cột "Dư nợ" zigzag KHỚP header "Nợ hiện tại".
    //    PN chỉ có status 0=DRAFT,1=COMPLETED,2=CANCELLED (không có status 4).
    const purchaseOrders = await this.prisma.purchaseOrder.findMany({
      where: {
        supplierId,
        ...SUPPLIER_DEBT_PO_WHERE,
      },
      select: {
        id: true,
        code: true,
        purchaseDate: true,
        total: true,
        discount: true,
        subTotal: true,
        paidAmount: true,
        debtAmount: true,
        createdAt: true,
        branchId: true,
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { purchaseDate: 'asc' },
    });

    for (const po of purchaseOrders) {
      timeline.push({
        type: 'purchase',
        id: po.id,
        code: po.code,
        date: po.purchaseDate,
        createdAt: po.createdAt,
        // total − discount (KHỚP supplierPoDebtAmount của Formula B). Trước
        // đây dùng subTotal; tại thời điểm tạo subTotal = total − discount nên
        // bằng nhau, nhưng thống nhất 1 nguồn để không lệch nếu data cũ lệch.
        amount: supplierPoDebtAmount(po),
        description: `Nhập hàng ${po.code}`,
        debtSnapshot: 0,
        branch: po.branch,
        user: po.creator,
      });
    }

    // 2. Lấy cashflows → trừ nợ (phiếu chi cho NCC)
    //    Đối xứng `customers.service.ts:1288-1294`: loại CashFlow CLONE
    //    `PCTUPN######` (tạo khi chuyển PDN → PN có thanh toán trước) khỏi
    //    timeline để tránh hiển thị 2 dòng payment trùng giá trị (1 dòng
    //    PCPDN gốc + 1 dòng PCTUPN clone). recalcSupplierDebt cũng filter
    //    cùng prefix tại `supplier-debt.util.ts`.
    const cashFlows = await this.prisma.cashFlow.findMany({
      where: {
        partnerType: 'S',
        partnerId: supplierId,
        status: { not: 2 },
        NOT: [
          { code: { startsWith: SUPPLIER_DEBT_CASHFLOW_PAID_EXCLUDE_PREFIX } },
        ],
      },
      select: {
        id: true,
        code: true,
        isReceipt: true,
        amount: true,
        transDate: true,
        method: true,
        description: true,
        createdAt: true,
        branchId: true,
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { transDate: 'asc' },
    });

    for (const cf of cashFlows) {
      timeline.push({
        type: cf.isReceipt ? 'balance_adjustment' : 'payment',
        id: cf.id,
        code: cf.code,
        date: cf.transDate,
        createdAt: cf.createdAt,
        amount: Number(cf.amount),
        method: cf.method,
        description:
          cf.description ||
          (cf.isReceipt ? `Cân bằng nợ ${cf.code}` : `Thanh toán ${cf.code}`),
        debtSnapshot: 0,
        branch: cf.branch,
        user: cf.creator,
      });
    }

    // 3. Lấy supplier returns đã xuất kho hoặc đã hoàn thành → trừ nợ.
    //    Dùng SUPPLIER_DEBT_SR_WHERE — CÙNG filter với Formula B: SR offsets
    //    gồm STOCK_EXPORTED(2) và COMPLETED(3). KHÔNG lọc CANCELLED(4)/DRAFT(5).
    const supplierReturns = await this.prisma.supplierReturn.findMany({
      where: {
        supplierId,
        ...SUPPLIER_DEBT_SR_WHERE,
      },
      select: {
        id: true,
        code: true,
        mode: true,
        status: true,
        refundType: true,
        refundAmount: true,
        refundedAmount: true,
        refundConfirmedAt: true,
        exportedAt: true,
        createdAt: true,
        branchId: true,
        branch: { select: { id: true, name: true } },
        refundConfirmer: { select: { id: true, name: true } },
        exporter: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, code: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    for (const sr of supplierReturns) {
      // status=3 (COMPLETED) dùng refundedAmount, status=2 (STOCK_EXPORTED)
      // dùng refundAmount — KHỚP supplierReturnOffsetAmount của Formula B.
      const amount = supplierReturnOffsetAmount(sr);

      const displayDate =
        sr.status === 3
          ? sr.refundConfirmedAt || sr.createdAt
          : sr.exportedAt || sr.createdAt;

      const description =
        sr.status === 2
          ? `Xuất kho trả hàng ${sr.code}`
          : sr.refundType === 'debt_offset'
            ? `Cấn trừ nợ ${sr.code}${sr.purchaseOrder ? ` (${sr.purchaseOrder.code})` : ''}`
            : `Trả hàng nhập ${sr.code}`;

      timeline.push({
        type: 'supplier_return',
        id: sr.id,
        code: sr.code,
        date: displayDate,
        createdAt: sr.createdAt,
        amount,
        status: sr.status,
        mode: sr.mode,
        refundType: sr.refundType,
        method: null,
        description,
        debtSnapshot: 0,
        branch: sr.branch,
        user: sr.status === 3 ? sr.refundConfirmer : sr.exporter,
      });
    }

    // 3. Sort tăng dần
    const calcOrder: Record<string, number> = {
      purchase: 0,
      balance_adjustment: 1,
      supplier_return: 2,
      payment: 3,
    };

    // Khóa tie-break phải DUY NHẤT để thứ tự xác định khi nhiều bản ghi
    // trùng cùng mốc thời gian: date → type (calcOrder) → createdAt → id.
    timeline.sort((a, b) => {
      const timeDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (timeDiff !== 0) return timeDiff;
      const typeDiff = (calcOrder[a.type] ?? 0) - (calcOrder[b.type] ?? 0);
      if (typeDiff !== 0) return typeDiff;
      const createdDiff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (createdDiff !== 0) return createdDiff;
      return (a.id ?? 0) - (b.id ?? 0);
    });

    // 4. Tính debtSnapshot
    let runningDebt = 0;
    for (const item of timeline) {
      if (item.type === 'purchase') {
        runningDebt += item.amount;
      } else if (item.type === 'balance_adjustment') {
        runningDebt += item.amount; // ← đối xứng KH "expense": cashflow thu S tăng debt
      } else if (item.type === 'supplier_return') {
        runningDebt -= item.amount; // ← trả hàng giảm nợ (mọi mode/refundType)
      } else if (item.type === 'payment') {
        runningDebt -= item.amount;
      }
      item.debtSnapshot = runningDebt;
    }

    // 5. Hiển thị mới → cũ. Phải là NGHỊCH ĐẢO chính xác của thứ tự cộng dồn
    // ở trên thì cột "Dư nợ" mới đơn điệu (không zigzag).
    timeline.reverse();

    return { data: timeline };
  }

  // ── Export lịch sử thanh toán NCC (timeline) ────────────────────────────────
  // Đối xứng customers.service.ts:exportDebtTimeline.
  async exportDebtTimeline(supplierId: number, res: Response): Promise<void> {
    const { data: timeline } = await this.getDebtTimeline(supplierId);

    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { code: true },
    });

    const pad = (n: number) => String(n).padStart(2, '0');
    const fmtDate = (d: any) => {
      if (!d) return '';
      const dt = new Date(d);
      return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    };

    const TYPE_LABEL: Record<string, string> = {
      purchase: 'Nhập hàng',
      payment: 'Thanh toán',
      balance_adjustment: 'Cân bằng nợ',
      supplier_return: 'Trả hàng nhập',
    };

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Lịch sử thanh toán');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã giao dịch', key: 'code', width: 18 },
      { header: 'Thời gian', key: 'date', width: 20 },
      { header: 'Loại giao dịch', key: 'type', width: 18 },
      { header: 'Mã NCC', key: 'supplierCode', width: 14 },
      { header: 'Chi nhánh', key: 'branch', width: 20 },
      { header: 'Người thực hiện', key: 'user', width: 18 },
      { header: 'Giá trị', key: 'amount', width: 16 },
      { header: 'Nợ cần trả NCC', key: 'debtSnapshot', width: 18 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.commit();

    timeline.forEach((item: any, idx: number) => {
      sheet
        .addRow({
          stt: idx + 1,
          code: item.code,
          date: fmtDate(item.date),
          type: TYPE_LABEL[item.type] ?? item.type,
          supplierCode: supplier?.code ?? '',
          branch: item.branch?.name ?? '',
          user: item.user?.name ?? '',
          amount: Number(item.amount),
          debtSnapshot: Number(item.debtSnapshot),
        })
        .commit();
    });

    await workbook.commit();
  }

  // ── Export công nợ chi tiết NCC ─────────────────────────────────────────────
  // Đối xứng customers.service.ts:exportCustomerDebt nhưng đảo vai trò:
  //   - Hóa đơn (bán) → Phiếu nhập (mua), ghi NỢ cho phía mình
  //   - Thu tiền KH → Chi tiền NCC (ghi CÓ)
  //   - Trả hàng KH → Trả hàng nhập NCC
  async exportSupplierDebt(
    supplierId: number,
    options: {
      fromDate?: string;
      toDate?: string;
      branchId?: number;
      includeDetails?: boolean;
      showUnit?: boolean;
      showQty?: boolean;
      showPrice?: boolean;
      showDiscount?: boolean;
      showTotal?: boolean;
      showNote?: boolean;
    },
    res: Response,
  ): Promise<void> {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: {
        id: true,
        code: true,
        name: true,
        contactNumber: true,
        debt: true,
      },
    });
    if (!supplier) throw new NotFoundException('Không tìm thấy nhà cung cấp');

    const branch = options.branchId
      ? await this.prisma.branch.findUnique({
          where: { id: options.branchId },
          select: { name: true, address: true, contactNumber: true },
        })
      : null;

    // ── 1. Lấy timeline + parse date filter ──────────────────────────────
    const { data: rawTimeline } = await this.getDebtTimeline(supplierId);

    const fromDate = options.fromDate ? new Date(options.fromDate) : null;
    const toDate = options.toDate ? new Date(options.toDate) : null;
    if (toDate) toDate.setHours(23, 59, 59, 999);

    let timeline = [...rawTimeline]; // desc (mới → cũ) từ getDebtTimeline
    if (fromDate) {
      timeline = timeline.filter((i: any) => new Date(i.date) >= fromDate);
    }
    if (toDate) {
      timeline = timeline.filter((i: any) => new Date(i.date) <= toDate);
    }

    // Ghi NỢ (debit) = phát sinh nợ mình phải trả NCC: phiếu nhập +
    //   cân bằng nợ (cashflow thu S). Ghi CÓ (credit) = giảm nợ: thanh toán +
    //   trả hàng nhập. Đối xứng Formula B.
    const isItemDebit = (item: any): boolean =>
      item.type === 'purchase' || item.type === 'balance_adjustment';

    // ── 2. Nợ đầu kỳ / cuối kỳ — lấy từ debtSnapshot ─────────────────────
    let noDauKy = 0;
    if (fromDate) {
      const beforeItem = rawTimeline.find(
        (i: any) => new Date(i.date) < fromDate,
      );
      if (beforeItem) noDauKy = Number(beforeItem.debtSnapshot ?? 0);
    }

    let noCuoiKy: number;
    if (toDate) {
      const lastInRange = rawTimeline.find(
        (i: any) => new Date(i.date) <= toDate,
      );
      noCuoiKy = lastInRange ? Number(lastInRange.debtSnapshot ?? 0) : noDauKy;
    } else {
      noCuoiKy = Number(supplier.debt ?? 0);
    }

    // ── 3. Phát sinh trong kỳ ────────────────────────────────────────────
    let totalDebit = 0;
    let totalCredit = 0;
    for (const item of timeline) {
      const amt = Number(item.amount);
      if (isItemDebit(item)) totalDebit += amt;
      else totalCredit += amt;
    }

    // ── 4. Batch fetch chi tiết PN + SupplierReturn ──────────────────────
    const purchaseOrderIds = timeline
      .filter((i: any) => i.type === 'purchase')
      .map((i: any) => i.id as number);
    const supplierReturnIds = timeline
      .filter((i: any) => i.type === 'supplier_return')
      .map((i: any) => i.id as number);

    const [poItems, srDetails, poHeaderRows] = await Promise.all([
      purchaseOrderIds.length > 0
        ? this.prisma.purchaseOrderItem.findMany({
            where: { purchaseOrderId: { in: purchaseOrderIds } },
            select: {
              purchaseOrderId: true,
              productCode: true,
              productName: true,
              quantity: true,
              price: true,
              discount: true,
              totalPrice: true,
              description: true,
              product: { select: { unit: true } },
            },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([]),
      supplierReturnIds.length > 0
        ? this.prisma.supplierReturnDetail.findMany({
            where: { supplierReturnId: { in: supplierReturnIds } },
            select: {
              supplierReturnId: true,
              productCode: true,
              productName: true,
              confirmedQuantity: true,
              returnPrice: true,
              totalAmount: true,
              note: true,
              product: { select: { unit: true } },
            },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([]),
      purchaseOrderIds.length > 0
        ? this.prisma.purchaseOrder.findMany({
            where: { id: { in: purchaseOrderIds } },
            select: {
              id: true,
              discount: true,
              discountRatio: true,
              totalAmount: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const poItemMap = new Map<number, any[]>();
    for (const d of poItems) {
      if (!poItemMap.has(d.purchaseOrderId))
        poItemMap.set(d.purchaseOrderId, []);
      poItemMap.get(d.purchaseOrderId)!.push(d);
    }

    const srDetailMap = new Map<number, any[]>();
    for (const d of srDetails) {
      if (!srDetailMap.has(d.supplierReturnId))
        srDetailMap.set(d.supplierReturnId, []);
      srDetailMap.get(d.supplierReturnId)!.push(d);
    }

    const poDiscountMap = new Map<
      number,
      { discount: number; discountRatio: number; totalAmount: number }
    >();
    for (const po of poHeaderRows) {
      poDiscountMap.set(po.id, {
        discount: Number(po.discount),
        discountRatio: Number(po.discountRatio),
        totalAmount: Number(po.totalAmount),
      });
    }

    // ── 5. Helper format ─────────────────────────────────────────────────
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmtDate = (d: any) => {
      if (!d) return '';
      const dt = new Date(d);
      return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    };

    const TYPE_LABEL: Record<string, string> = {
      purchase: 'Nhập hàng',
      payment: 'Thanh toán',
      balance_adjustment: 'Cân bằng nợ',
      supplier_return: 'Trả hàng nhập',
    };

    // ── 6. Build workbook ────────────────────────────────────────────────
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Công nợ chi tiết');

    const COL_WIDTHS = [6, 20, 16, 36, 8, 10, 14, 12, 8, 14, 14, 16, 16];
    COL_WIDTHS.forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });

    const r1 = sheet.addRow(['Diệp Trà']);
    r1.getCell(1).font = { bold: true, size: 13 };

    const r2 = sheet.addRow(['Chi nhánh', branch?.name ?? '']);
    r2.getCell(1).font = { bold: true };

    const r3 = sheet.addRow(['Địa chỉ', branch?.address ?? '']);
    r3.getCell(1).font = { bold: true };

    const r4 = sheet.addRow(['Điện thoại', branch?.contactNumber ?? '']);
    r4.getCell(1).font = { bold: true };

    const titleRow = sheet.addRow([]);
    sheet.mergeCells(`A${titleRow.number}:M${titleRow.number}`);
    titleRow.getCell(1).value = 'Công nợ chi tiết nhà cung cấp';
    titleRow.getCell(1).font = { bold: true, size: 14 };
    titleRow.getCell(1).alignment = {
      horizontal: 'center',
      vertical: 'middle',
    };

    const hasDateFilter = fromDate || toDate;
    if (hasDateFilter) {
      const fmtDay = (d: Date) =>
        `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
      const fromStr = fromDate ? fmtDay(fromDate) : '...';
      const toStr = toDate ? fmtDay(toDate) : '...';
      const dateRow = sheet.addRow([]);
      sheet.mergeCells(`A${dateRow.number}:M${dateRow.number}`);
      dateRow.getCell(1).value = `Từ ngày ${fromStr} đến ngày ${toStr}`;
      dateRow.getCell(1).alignment = {
        horizontal: 'center',
        vertical: 'middle',
      };
    }

    sheet.addRow([]);

    const r6 = sheet.addRow([
      'Nhà cung cấp',
      supplier.name,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'Nợ đầu kỳ',
      noDauKy,
    ]);
    r6.getCell(1).font = { bold: true };
    r6.getCell(12).font = { bold: true };

    const r7 = sheet.addRow([
      'Mã NCC',
      supplier.code ?? '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'Phát sinh trong kỳ',
      totalDebit,
      totalCredit,
    ]);
    r7.getCell(1).font = { bold: true };
    r7.getCell(12).font = { bold: true };

    const r8 = sheet.addRow([
      'Điện thoại',
      supplier.contactNumber ?? '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'Nợ cuối kỳ',
      noCuoiKy,
    ]);
    r8.getCell(1).font = { bold: true };
    r8.getCell(12).font = { bold: true };

    sheet.addRow([]);

    const HEADER_FILL: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    const hRow = sheet.addRow([
      '',
      'Thời gian',
      'Mã',
      'Diễn giải',
      'DVT',
      'SL',
      'Đơn giá',
      'Giảm giá',
      'VAT',
      'Giá nhập/trả',
      'Thành tiền',
      'Ghi nợ',
      'Ghi có',
    ]);
    hRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      };
    });

    let stt = 0;
    const numFmt = '#,##0';

    for (const item of timeline) {
      const debitItem = isItemDebit(item);
      const debit = debitItem ? Number(item.amount) : null;
      const credit = !debitItem ? Number(item.amount) : null;

      stt++;

      const mainRow = sheet.addRow([
        stt,
        fmtDate(item.date),
        item.code,
        TYPE_LABEL[item.type] ?? item.type,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        debit ?? '',
        credit ?? '',
      ]);
      mainRow.getCell(1).alignment = { horizontal: 'center' };
      mainRow.getCell(12).numFmt = numFmt;
      mainRow.getCell(13).numFmt = numFmt;
      if (debitItem) {
        mainRow.getCell(12).font = { color: { argb: 'FFCC0000' } };
      } else {
        mainRow.getCell(13).font = { color: { argb: 'FF006600' } };
      }

      // Sub-rows: chi tiết phiếu nhập
      if (options.includeDetails && item.type === 'purchase') {
        const details = poItemMap.get(item.id as number) ?? [];
        for (const d of details) {
          const unitPrice = Number(d.price);
          const discountPerUnit = Number(d.discount);
          const buyPrice = unitPrice - discountPerUnit;
          const qty = Number(d.quantity);

          const subRow = sheet.addRow([
            '',
            '',
            d.productCode,
            d.productName + (d.description ? ` (${d.description})` : ''),
            options.showUnit ? (d.product?.unit ?? '') : '',
            options.showQty ? qty : '',
            options.showPrice ? unitPrice : '',
            options.showDiscount ? discountPerUnit : '',
            0, // VAT
            options.showTotal ? buyPrice : '',
            options.showTotal ? Number(d.totalPrice) : '',
            '',
            '',
          ]);

          subRow.font = { color: { argb: 'FF444444' } };
          subRow.getCell(7).numFmt = numFmt;
          subRow.getCell(8).numFmt = numFmt;
          subRow.getCell(10).numFmt = numFmt;
          subRow.getCell(11).numFmt = numFmt;
        }

        const poDisc = poDiscountMap.get(item.id as number);
        if (poDisc) {
          const totalDiscAmt =
            (poDisc.discountRatio > 0
              ? (poDisc.totalAmount * poDisc.discountRatio) / 100
              : 0) + poDisc.discount;

          if (totalDiscAmt > 0) {
            const discLabel =
              poDisc.discountRatio > 0
                ? `Chiết khấu(${poDisc.discountRatio}%)`
                : 'Chiết khấu';

            const discRow = sheet.addRow([
              '',
              '',
              '',
              discLabel,
              '',
              '',
              '',
              '',
              '',
              '',
              totalDiscAmt,
              '',
              '',
            ]);
            discRow.font = { italic: true, color: { argb: 'FF666666' } };
            discRow.getCell(11).numFmt = numFmt;
          }
        }
      }

      // Sub-rows: chi tiết trả hàng nhập
      if (options.includeDetails && item.type === 'supplier_return') {
        const details = srDetailMap.get(item.id as number) ?? [];
        for (const d of details) {
          const returnPrice = Number(d.returnPrice);
          const qty = Number(d.confirmedQuantity);

          const subRow = sheet.addRow([
            '',
            '',
            d.productCode,
            d.productName + (d.note ? ` (${d.note})` : ''),
            options.showUnit ? (d.product?.unit ?? '') : '',
            options.showQty ? qty : '',
            options.showPrice ? returnPrice : '',
            options.showDiscount ? 0 : '',
            0, // VAT
            options.showTotal ? returnPrice : '',
            options.showTotal ? Number(d.totalAmount) : '',
            '',
            '',
          ]);

          subRow.font = { color: { argb: 'FF444444' } };
          subRow.getCell(7).numFmt = numFmt;
          subRow.getCell(10).numFmt = numFmt;
          subRow.getCell(11).numFmt = numFmt;
        }
      }
    }

    const totalRow = sheet.addRow([
      '',
      'Tổng cộng',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      totalDebit,
      totalCredit,
    ]);
    totalRow.getCell(2).font = { bold: true };
    totalRow.getCell(12).font = { bold: true };
    totalRow.getCell(13).font = { bold: true };
    totalRow.getCell(12).numFmt = numFmt;
    totalRow.getCell(13).numFmt = numFmt;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    await workbook.xlsx.write(res);
    res.end();
  }

  async importBalanceAdjustments(dto: ImportSupplierBalanceAdjustmentsDto) {
    const results = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [] as { row: number; code: string; message: string }[],
    };

    for (let i = 0; i < dto.rows.length; i++) {
      const row = dto.rows[i];
      try {
        // 1. Lookup supplier by code
        const supplier = await this.prisma.supplier.findFirst({
          where: { code: row.supplierCode },
          select: { id: true, name: true, contactNumber: true, address: true },
        });

        if (!supplier) {
          results.errors.push({
            row: i + 1,
            code: row.code,
            message: `Không tìm thấy NCC với mã ${row.supplierCode}`,
          });
          continue;
        }

        // 2. Parse transDate — có xử lý Excel serial number
        const isReceipt = row.amount > 0;
        const absAmount = Math.abs(row.amount);

        let transDate = new Date();
        if (row.transDate) {
          const raw = String(row.transDate).trim();

          const serial = Number(raw);
          if (!isNaN(serial) && serial > 30000 && serial < 60000) {
            // safety net nếu frontend vẫn gửi serial string
            const parsed = new Date(
              Math.round((serial - 25569) * 86400 * 1000),
            );
            if (!isNaN(parsed.getTime())) transDate = parsed;
          } else {
            const match = raw.match(
              /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
            );
            if (match) {
              const [, d, m, y, hh = '0', mm = '0', ss = '0'] = match;
              const parsed = new Date(+y, +m - 1, +d, +hh, +mm, +ss);
              if (!isNaN(parsed.getTime())) transDate = parsed;
            } else {
              const parsed = new Date(raw);
              if (!isNaN(parsed.getTime())) transDate = parsed;
            }
          }
        }

        // 3. Upsert
        const existing = await this.prisma.cashFlow.findUnique({
          where: { code: row.code },
          select: { id: true },
        });

        await this.prisma.cashFlow.upsert({
          where: { code: row.code },
          update: {
            isReceipt,
            amount: absAmount,
            transDate,
            partnerId: supplier.id,
            partnerName: supplier.name,
            contactNumber: supplier.contactNumber,
            address: supplier.address,
          },
          create: {
            code: row.code,
            branchId: 1,
            isReceipt,
            amount: absAmount,
            transDate,
            method: null,
            partnerType: 'S',
            partnerId: supplier.id,
            partnerName: supplier.name,
            contactNumber: supplier.contactNumber,
            address: supplier.address,
            description: `Cân bằng nợ ${row.code}`,
            status: 0,
            statusValue: isReceipt ? 'Cân bằng nợ' : 'Đã chi',
            createdBy: 1,
            usedForFinancialReporting: 1,
          },
        });

        if (existing) {
          results.updated++; // ← fix bug 2: đúng counter
        } else {
          results.created++;
        }
      } catch (error: any) {
        results.errors.push({
          row: i + 1,
          code: row.code,
          message: error.message,
        });
      }
    }

    return {
      message: `Import ${results.created} mới, cập nhật ${results.updated} phiếu`,
      ...results,
    };
  }
}
