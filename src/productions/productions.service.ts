import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
  CreateProductionDto,
  UpdateProductionDto,
  ProductionQueryDto,
  SendProductionDto,
  ReceiveProductionDto,
  ApplyProductionCostDto,
  CancelSentProductionDto,
} from './dto';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import { DEFAULT_COMPONENTS_WHERE } from '../products/product-formulas.util';
import {
  buildInventoryLogActor,
  buildInventoryLogBase,
  InventoryLogActor,
} from '../common/inventory-log.util';
import { recalcSupplierDebt } from '../common/supplier-debt.util';
import {
  PRODUCTION_STATUS,
  computeWeightedAverageCost,
  productionFeeInVnd,
} from '../common/production-factory.util';

// Quan hệ đọc kèm phiếu để hiển thị nhà máy / NCC của phiếu Gửi sản xuất.
const PRODUCTION_PARTNER_INCLUDE = {
  factory: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, code: true, name: true } },
};

@Injectable()
export class ProductionsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  // Bộ lọc dùng chung cho findAll + export (tổng quan/chi tiết) để file xuất
  // khớp đúng danh sách đang hiển thị trên UI.
  private buildProductionWhere(query: ProductionQueryDto): any {
    const {
      branchIds,
      status,
      fromManufacturedDate,
      toManufacturedDate,
      search,
    } = query;

    const where: any = {};
    const and: any[] = [];

    if (branchIds && branchIds.length > 0) {
      and.push({
        OR: [
          { sourceBranchId: { in: branchIds } },
          { destinationBranchId: { in: branchIds } },
        ],
      });
    }

    if (status && status.length > 0) {
      where.status = { in: status };
    }

    if (query.isExternal !== undefined) {
      where.isExternal = query.isExternal;
    }

    if (fromManufacturedDate || toManufacturedDate) {
      where.manufacturedDate = {};
      if (fromManufacturedDate) {
        where.manufacturedDate.gte = new Date(fromManufacturedDate);
      }
      if (toManufacturedDate) {
        where.manufacturedDate.lte = new Date(toManufacturedDate);
      }
    }

    if (search) {
      and.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { productName: { contains: search, mode: 'insensitive' } },
          { productCode: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    if (and.length > 0) {
      where.AND = and;
    }

    return where;
  }

  async findAll(query: ProductionQueryDto) {
    const { pageSize = 15, currentItem = 0 } = query;

    const where = this.buildProductionWhere(query);

    const [total, data] = await Promise.all([
      this.prisma.production.count({ where }),
      this.prisma.production.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: PRODUCTION_PARTNER_INCLUDE,
      }),
    ]);

    return {
      total,
      pageSize,
      data,
    };
  }

  // Nhãn trạng thái dùng chung cho cả 2 file xuất.
  private static readonly EXPORT_STATUS_LABEL: Record<number, string> = {
    1: 'Phiếu tạm',
    2: 'Hoàn thành',
    3: 'Đã hủy',
    4: 'Đã gửi',
  };

  /**
   * Xuất file TỔNG QUAN: mỗi phiếu sản xuất = 1 dòng Excel. Bộ lọc dùng chung
   * buildProductionWhere với findAll để khớp danh sách đang hiển thị.
   */
  async exportProductions(
    query: ProductionQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildProductionWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Sản xuất');

    sheet.columns = [
      { header: 'Mã sản xuất', key: 'code', width: 18 },
      { header: 'Thời gian SX', key: 'manufacturedDate', width: 20 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên sản phẩm', key: 'productName', width: 36 },
      { header: 'Kho đầu vào', key: 'sourceBranch', width: 22 },
      { header: 'Kho đầu ra', key: 'destinationBranch', width: 22 },
      { header: 'Số lượng', key: 'quantity', width: 12 },
      { header: 'Tổng chi phí', key: 'totalCost', width: 16 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Ghi chú', key: 'note', width: 30 },
      { header: 'Ngày tạo', key: 'createdAt', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 500;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.production.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
      });

      if (batch.length === 0) break;

      for (const p of batch) {
        const row = sheet.addRow({
          code: p.code,
          manufacturedDate: fmtDateTime(p.manufacturedDate),
          productCode: p.productCode || '',
          productName: p.productName || '',
          sourceBranch: p.sourceBranchName || '',
          destinationBranch: p.destinationBranchName || '',
          quantity: Number(p.quantity) || 0,
          totalCost: Number(p.totalCost) || 0,
          createdBy: p.createdByName || '',
          note: p.note || '',
          createdAt: fmtDateTime(p.createdAt),
          status: ProductionsService.EXPORT_STATUS_LABEL[p.status] || '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi nguyên liệu (component) trong phiếu = 1 dòng Excel,
   * kèm thông tin phiếu. Bộ lọc dùng chung buildProductionWhere với export tổng
   * quan.
   */
  async exportProductionsDetail(
    query: ProductionQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildProductionWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết sản xuất');

    sheet.columns = [
      { header: 'Mã sản xuất', key: 'code', width: 18 },
      { header: 'Thời gian SX', key: 'manufacturedDate', width: 20 },
      { header: 'Kho đầu vào', key: 'sourceBranch', width: 22 },
      { header: 'Kho đầu ra', key: 'destinationBranch', width: 22 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Mã thành phẩm', key: 'productCode', width: 16 },
      { header: 'Tên thành phẩm', key: 'productName', width: 30 },
      { header: 'SL thành phẩm', key: 'quantity', width: 12 },
      { header: 'Công thức', key: 'formulaName', width: 18 },
      { header: 'Mã nguyên liệu', key: 'componentCode', width: 16 },
      { header: 'Tên nguyên liệu', key: 'componentName', width: 30 },
      { header: 'SL nguyên liệu (g)', key: 'actualGrams', width: 16 },
      { header: 'Định lượng (g)', key: 'formulaGrams', width: 14 },
      { header: 'SL trừ kho', key: 'unitsDeducted', width: 14 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 300;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.production.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: { components: true },
      });

      if (batch.length === 0) break;

      for (const p of batch) {
        const base = {
          code: p.code,
          manufacturedDate: fmtDateTime(p.manufacturedDate),
          sourceBranch: p.sourceBranchName || '',
          destinationBranch: p.destinationBranchName || '',
          createdBy: p.createdByName || '',
          status: ProductionsService.EXPORT_STATUS_LABEL[p.status] || '',
          productCode: p.productCode || '',
          productName: p.productName || '',
          quantity: Number(p.quantity) || 0,
          formulaName: p.formulaName || '',
        };

        if (!p.components.length) {
          const row = sheet.addRow({
            ...base,
            componentCode: '',
            componentName: '',
            formulaGrams: 0,
            actualGrams: 0,
            unitsDeducted: 0,
          });
          row.commit();
          continue;
        }

        for (const c of p.components) {
          const row = sheet.addRow({
            ...base,
            componentCode: c.componentCode || '',
            componentName: c.componentName || '',
            formulaGrams: Number(c.formulaGrams) || 0,
            actualGrams: Number(c.actualGrams) || 0,
            unitsDeducted: Number(c.unitsDeducted) || 0,
          });
          row.commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number) {
    const production = await this.prisma.production.findUnique({
      where: { id },
      include: { components: true, ...PRODUCTION_PARTNER_INCLUDE },
    });

    if (!production) {
      throw new NotFoundException(`Production with ID ${id} not found`);
    }

    return production;
  }

  async create(dto: CreateProductionDto, userId: number) {
    const { product, formula } = await this.loadProductWithFormula(
      this.prisma,
      dto.productId,
      dto.formulaId,
    );

    if (!product) throw new NotFoundException('Product not found');
    if (product.type !== 4) {
      throw new BadRequestException(
        'Product must be a manufacturing product (type = 4)',
      );
    }
    if (!product.weight) {
      throw new BadRequestException(
        'Manufacturing product must have weight defined',
      );
    }

    const sourceBranch = await this.prisma.branch.findUnique({
      where: { id: dto.sourceBranchId },
    });
    if (!sourceBranch) throw new NotFoundException('Source branch not found');

    const destinationBranch = await this.prisma.branch.findUnique({
      where: { id: dto.destinationBranchId },
    });
    if (!destinationBranch)
      throw new NotFoundException('Destination branch not found');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // Phiếu Gửi sản xuất luôn bắt đầu là phiếu tạm; trừ kho khi bấm Gửi hàng.
    const external = dto.isExternal
      ? await this.resolveExternalFields(this.prisma, dto)
      : null;

    const lastProduction = await this.prisma.production.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    let nextNumber = 1;
    if (lastProduction?.code) {
      const match = lastProduction.code.match(/\d+$/);
      if (match) nextNumber = parseInt(match[0]) + 1;
    }

    const code =
      dto.code ||
      `${external ? 'GSX' : 'SX'}${String(nextNumber).padStart(6, '0')}`;
    const totalCost = this.calculateTotalCost(
      product.comboComponents,
      dto.sourceBranchId,
      dto.quantity,
    );

    return await this.prisma.$transaction(async (tx) => {
      const production = await tx.production.create({
        data: {
          code,
          sourceBranchId: dto.sourceBranchId,
          sourceBranchName: sourceBranch.name,
          destinationBranchId: dto.destinationBranchId,
          destinationBranchName: destinationBranch.name,
          productId: dto.productId,
          productCode: product.code,
          productName: product.name,
          quantity: dto.quantity,
          totalCost: await totalCost,
          note: dto.note,
          status: external ? PRODUCTION_STATUS.DRAFT : dto.status || 1,
          createdById: userId,
          createdByName: user?.name || '',
          autoDeductComponents: dto.autoDeductComponents ?? true,
          manufacturedDate: dto.manufacturedDate
            ? new Date(dto.manufacturedDate)
            : new Date(),
          formulaId: formula?.id ?? null,
          formulaName: formula?.name ?? null,
          ...(external ? { isExternal: true, ...external } : {}),
        },
      });

      if (!external && dto.status === 2 && dto.autoDeductComponents) {
        await this.processInventoryChanges(
          tx,
          product,
          dto.sourceBranchId,
          dto.destinationBranchId,
          dto.quantity,
          dto.components, // ← actualComponents
          {
            id: production.id,
            code: production.code,
            manufacturedDate: production.manufacturedDate,
          },
          buildInventoryLogActor(userId, user?.name),
        );
      }

      // Khai báo ngoài if để snapshot audit log có thể truy cập danh sách
      // nguyên liệu đã xuất (comboComponents) cho truy vết.
      let componentDetails: any[] = [];
      if (dto.components && dto.components.length > 0) {
        componentDetails = await Promise.all(
          dto.components.map(async (c) => {
            const comp = product.comboComponents.find(
              (pc) => pc.componentProductId === c.componentProductId,
            );
            const componentProduct = comp?.componentProduct;
            const weightInGrams =
              componentProduct?.weightUnit === 'kg'
                ? Number(componentProduct.weight) * 1000
                : Number(componentProduct?.weight || 0);

            return {
              productionId: production.id,
              componentProductId: c.componentProductId,
              componentCode: componentProduct?.code || '',
              componentName: componentProduct?.name || '',
              formulaGrams: c.formulaGrams,
              actualGrams: c.actualGrams,
              // weight=0 (piece/carton): actualGrams chính là số đơn vị/thùng
              unitsDeducted:
                weightInGrams > 0
                  ? c.actualGrams / weightInGrams
                  : c.actualGrams,
              inputMode: comp?.inputMode ?? null,
            };
          }),
        );

        await tx.productionComponent.createMany({ data: componentDetails });
      }

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'PRODUCTION_CREATE',
        entityType: 'productions',
        entityId: production.id.toString(),
        entityCode: production.code,
        category: getCategoryFromActionCode('PRODUCTION_CREATE'),
        severity: getSeverityFromActionCode('PRODUCTION_CREATE'),
        snapshot: this.buildProductionSnapshot(production, componentDetails),
        message: renderAuditMessage('PRODUCTION_CREATE', {
          productionCode: production.code,
        }),
        messageTemplate: 'PRODUCTION_CREATE',
        userId,
        userName: user?.name || 'System',
        branchId: dto.sourceBranchId,
      });

      return production;
    });
  }

  async update(id: number, dto: UpdateProductionDto, userId?: number) {
    const production = await this.findOne(id);

    const updateData: any = {};

    // Phiếu Gửi sản xuất: chỉ sửa được khi còn phiếu tạm; chuyển trạng thái
    // phải qua Gửi hàng / Nhận hàng / Hủy phiếu (endpoint riêng).
    if (production.isExternal) {
      if (production.status !== PRODUCTION_STATUS.DRAFT) {
        throw new BadRequestException(
          'Phiếu gửi sản xuất đã gửi hàng, không thể chỉnh sửa',
        );
      }
      if (
        dto.status !== undefined &&
        dto.status !== PRODUCTION_STATUS.DRAFT &&
        dto.status !== PRODUCTION_STATUS.CANCELLED
      ) {
        throw new BadRequestException(
          'Dùng nút Gửi hàng / Nhận hàng để chuyển trạng thái phiếu gửi sản xuất',
        );
      }
      Object.assign(
        updateData,
        await this.resolveExternalFields(this.prisma, {
          supplierId: dto.supplierId ?? production.supplierId ?? undefined,
          factoryId:
            dto.factoryId !== undefined ? dto.factoryId : production.factoryId,
          feeCurrency: dto.feeCurrency ?? production.feeCurrency,
          processingFee: dto.processingFee ?? Number(production.processingFee),
          feeForeignAmount:
            dto.feeForeignAmount ??
            (production.feeForeignAmount != null
              ? Number(production.feeForeignAmount)
              : undefined),
          feeExchangeRate:
            dto.feeExchangeRate ??
            (production.feeExchangeRate != null
              ? Number(production.feeExchangeRate)
              : undefined),
        }),
      );
    }
    if (dto.quantity !== undefined) updateData.quantity = dto.quantity;
    if (dto.note !== undefined) updateData.note = dto.note;
    if (dto.status !== undefined) updateData.status = dto.status;
    if (dto.manufacturedDate !== undefined) {
      updateData.manufacturedDate = new Date(dto.manufacturedDate);
    }
    if (dto.autoDeductComponents !== undefined) {
      updateData.autoDeductComponents = dto.autoDeductComponents;
    }

    // Chỉ đổi công thức khi phiếu còn tạm; còn lại dùng công thức đã lưu.
    const formulaChanged =
      dto.formulaId !== undefined &&
      dto.formulaId !== production.formulaId &&
      production.status === 1;
    const formulaId = formulaChanged ? dto.formulaId : production.formulaId;

    return await this.prisma.$transaction(async (tx) => {
      if (
        production.status === 1 &&
        (formulaChanged || dto.quantity !== undefined)
      ) {
        const { product, formula } = await this.loadProductWithFormula(
          tx,
          production.productId,
          formulaId,
        );
        if (formulaChanged) {
          updateData.formulaId = formula?.id ?? null;
          updateData.formulaName = formula?.name ?? null;
        }
        updateData.totalCost = await this.calculateTotalCost(
          product?.comboComponents ?? [],
          production.sourceBranchId,
          Number(dto.quantity ?? production.quantity),
        );
      }

      // ── Lưu components khi lưu tạm (status 1) ──────────────────────
      // Chỉ lưu data, KHÔNG xử lý tồn kho
      if (dto.status !== 2 && dto.components && dto.components.length > 0) {
        const { product: productForDraft } = await this.loadProductWithFormula(
          tx,
          production.productId,
          formulaId,
        );

        if (productForDraft) {
          await tx.productionComponent.deleteMany({
            where: { productionId: id },
          });

          const draftComponentDetails = dto.components.map((c) => {
            const comp = productForDraft.comboComponents.find(
              (pc) => pc.componentProductId === c.componentProductId,
            );
            const componentProduct = comp?.componentProduct;
            const weightInGrams =
              componentProduct?.weightUnit === 'kg'
                ? Number(componentProduct.weight) * 1000
                : Number(componentProduct?.weight || 0);

            return {
              productionId: id,
              componentProductId: c.componentProductId,
              componentCode: componentProduct?.code || '',
              componentName: componentProduct?.name || '',
              formulaGrams: c.formulaGrams,
              actualGrams: c.actualGrams,
              // weight=0 (piece/carton): actualGrams chính là số đơn vị/thùng
              unitsDeducted:
                weightInGrams > 0
                  ? c.actualGrams / weightInGrams
                  : c.actualGrams,
              inputMode: comp?.inputMode ?? null,
            };
          });

          await tx.productionComponent.createMany({
            data: draftComponentDetails,
          });
        }
      }
      // ───────────────────────────────────────────────────────────────

      // Trường hợp 1: Phiếu tạm (1) → Hoàn thành (2)
      // Xử lý tồn kho + lưu components
      if (dto.status === 2 && production.status !== 2) {
        const { product } = await this.loadProductWithFormula(
          tx,
          production.productId,
          formulaId,
        );

        if (product && updateData.autoDeductComponents !== false) {
          // Fetch người thực hiện để ghi userId/createdByName vào InventoryLog
          // (truy vết ai xuất nguyên liệu/nhập thành phẩm khi cập nhật sản xuất).
          const prodUpdateUser = userId
            ? await tx.user.findUnique({
                where: { id: userId },
                select: { name: true, email: true },
              })
            : null;
          const prodUpdateLogActor = buildInventoryLogActor(
            userId,
            prodUpdateUser?.name || prodUpdateUser?.email,
          );
          await this.processInventoryChanges(
            tx,
            product,
            production.sourceBranchId,
            production.destinationBranchId,
            Number(dto.quantity ?? production.quantity),
            dto.components,
            {
              id: production.id,
              code: production.code,
              manufacturedDate: dto.manufacturedDate
                ? new Date(dto.manufacturedDate)
                : production.manufacturedDate,
            },
            prodUpdateLogActor,
          );
        }

        if (dto.components && dto.components.length > 0 && product) {
          await tx.productionComponent.deleteMany({
            where: { productionId: id },
          });

          const componentDetails = await Promise.all(
            dto.components.map(async (c) => {
              const comp = product.comboComponents.find(
                (pc) => pc.componentProductId === c.componentProductId,
              );
              const componentProduct = comp?.componentProduct;
              const weightInGrams =
                componentProduct?.weightUnit === 'kg'
                  ? Number(componentProduct.weight) * 1000
                  : Number(componentProduct?.weight || 0);

              return {
                productionId: id,
                componentProductId: c.componentProductId,
                componentCode: componentProduct?.code || '',
                componentName: componentProduct?.name || '',
                formulaGrams: c.formulaGrams,
                actualGrams: c.actualGrams,
                // weight=0 (piece/carton): actualGrams chính là số đơn vị/thùng
                unitsDeducted:
                  weightInGrams > 0
                    ? c.actualGrams / weightInGrams
                    : c.actualGrams,
                inputMode: comp?.inputMode ?? null,
              };
            }),
          );

          await tx.productionComponent.createMany({ data: componentDetails });
        }
      }

      // Trường hợp 2: Hoàn thành (2) → Hủy (3)
      if (dto.status === 3 && production.status === 2) {
        const { product } = await this.loadProductWithFormula(
          tx,
          production.productId,
          production.formulaId,
        );

        if (product && production.autoDeductComponents) {
          // LOG-TRUTH: đổi status → 3 (CANCELLED) TRƯỚC để active-finder loại
          // toàn bộ log của phiếu (PRODUCTION_OUT/IN, refType='production',
          // status!=3) khỏi Σ, rồi recalc đưa onHand component@source +
          // thành phẩm@dest về Σ log active (tự khôi phục đúng số đã trừ/cộng).
          await tx.production.update({
            where: { id },
            data: { status: 3 },
          });

          await this.reverseInventoryChanges(
            tx,
            product,
            production.sourceBranchId,
            production.destinationBranchId,
            production.components,
          );
        }
      }

      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });

        const updatedProduction = await tx.production.findUnique({
          where: { id },
          include: { components: true },
        });

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'PRODUCTION_UPDATE',
          entityType: 'productions',
          entityId: id.toString(),
          entityCode: production.code,
          category: getCategoryFromActionCode('PRODUCTION_UPDATE'),
          severity: getSeverityFromActionCode('PRODUCTION_UPDATE'),
          snapshot: this.buildProductionSnapshot(
            updatedProduction || production,
          ),
          message: renderAuditMessage('PRODUCTION_UPDATE', {
            productionCode: production.code,
          }),
          messageTemplate: 'PRODUCTION_UPDATE',
          userId,
          userName: user?.name || 'System',
          branchId: production.sourceBranchId,
        });
      }

      return tx.production.update({
        where: { id },
        data: updateData,
      });
    });
  }

  async remove(id: number, userId?: number) {
    const production = await this.prisma.production.findUnique({
      where: { id },
      include: {
        components: true,
        product: {
          include: {
            comboComponents: {
              where: DEFAULT_COMPONENTS_WHERE,
              include: { componentProduct: true },
            },
          },
        },
      },
    });

    if (!production) {
      throw new NotFoundException(`Production with id ${id} not found`);
    }

    if (
      production.isExternal &&
      production.status !== PRODUCTION_STATUS.DRAFT &&
      production.status !== PRODUCTION_STATUS.CANCELLED
    ) {
      throw new BadRequestException(
        'Phiếu gửi sản xuất đã gửi hàng, không thể xóa — dùng Hủy phiếu',
      );
    }

    // LOG-TRUTH: xóa cứng phiếu trong transaction; log PRODUCTION_OUT/IN trỏ
    // refId này sẽ thành inactive (active-finder không tìm thấy phiếu) → recalc
    // đưa onHand component@source + thành phẩm@dest về Σ log active. Chỉ recalc
    // khi phiếu ĐÃ hoàn thành (status=2) vì chỉ khi đó mới có log để loại.
    await this.prisma.$transaction(async (tx) => {
      await tx.production.delete({ where: { id } });

      if (production.status === 2 && production.product) {
        const affectedPairs: { productId: number; branchId: number }[] = [
          {
            productId: production.productId,
            branchId: production.destinationBranchId,
          },
        ];
        // Snapshot thành phần đã xuất + công thức mặc định hiện tại.
        const componentIds = new Set([
          ...production.components.map((c) => c.componentProductId),
          ...production.product.comboComponents.map(
            (c) => c.componentProductId,
          ),
        ]);
        for (const componentProductId of componentIds) {
          affectedPairs.push({
            productId: componentProductId,
            branchId: production.sourceBranchId,
          });
        }
        await recalcOnHandForPairs(tx, affectedPairs);
      }
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PRODUCTION_DELETE',
        entityType: 'productions',
        entityId: id.toString(),
        entityCode: production.code,
        category: getCategoryFromActionCode('PRODUCTION_DELETE'),
        severity: getSeverityFromActionCode('PRODUCTION_DELETE'),
        snapshot: this.buildProductionSnapshot(production),
        message: renderAuditMessage('PRODUCTION_DELETE', {
          productionCode: production.code,
        }),
        messageTemplate: 'PRODUCTION_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: production.sourceBranchId || undefined,
      });
    }

    return { message: 'Xóa phiếu sản xuất thành công' };
  }

  private async calculateTotalCost(
    components: any[],
    branchId: number,
    quantity: number,
  ): Promise<number> {
    let totalCost = 0;

    for (const comp of components) {
      const inventory = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: branchId,
          },
        },
      });

      if (inventory) {
        // ─── PIECE / CARTON MODE ────────────────────────────────────
        // Cả hai mode tính cost theo đơn vị: cost/đơn-vị × tổng-đơn-vị.
        // CARTON: comp.quantity = 1/N (N = sức chứa) → mỗi thành phẩm gánh
        // cost-thùng/N; nhân quantity sản xuất ra tổng số thùng tiêu hao.
        if (comp.inputMode === 'piece' || comp.inputMode === 'carton') {
          const totalUnits = Number(comp.quantity) * Number(quantity);
          totalCost += Number(inventory.cost) * totalUnits;
          continue;
        }
        // ─────────────────────────────────────────────────────────────

        const componentWeight = comp.componentProduct.weight
          ? Number(comp.componentProduct.weight)
          : 0;
        const componentWeightUnit = comp.componentProduct.weightUnit || 'g';
        const weightInGrams =
          componentWeightUnit === 'kg'
            ? componentWeight * 1000
            : componentWeight;

        if (weightInGrams > 0) {
          const requiredGrams = Number(comp.quantity) * Number(quantity);
          const costPerGram = Number(inventory.cost) / weightInGrams;
          totalCost += costPerGram * requiredGrams;
        }
      }
    }

    return totalCost;
  }

  private async processInventoryChanges(
    tx: any,
    product: any,
    sourceBranchId: number,
    destinationBranchId: number,
    quantity: number,
    actualComponents?: { componentProductId: number; actualGrams: number }[],
    production?: { id: number; code: string; manufacturedDate?: Date | null },
    actor?: InventoryLogActor,
  ) {
    // refCode/refId neo log về chính phiếu sản xuất → active-finder
    // (status != 3) loại log khi phiếu bị hủy/xóa. transactionDate neo theo
    // manufacturedDate để phiếu lùi ngày đứng đúng vị trí trên thẻ kho.
    const ref = {
      id: production?.id || 0,
      code: production?.code || '',
      transactionDate: production?.manufacturedDate || new Date(),
    };

    const { pairs } = await this.writeComponentOutLogs(
      tx,
      product,
      sourceBranchId,
      quantity,
      actualComponents,
      ref,
      actor,
    );
    const finishedPair = await this.writeFinishedInLog(
      tx,
      product,
      destinationBranchId,
      quantity,
      ref,
      actor,
    );

    // NGUỒN CHÂN LÝ: onHand = Σ log active. Sau khi đã ghi mọi log
    // PRODUCTION_OUT/IN, recalc lại onHand từ thẻ kho.
    await recalcOnHandForPairs(tx, [...pairs, finishedPair]);
  }

  /**
   * Ghi PRODUCTION_OUT cho từng nguyên liệu của công thức tại kho nguồn.
   * Trả về các cặp cần recalc + tổng giá vốn nguyên liệu đã xuất. KHÔNG
   * recalc — nơi gọi gom cặp rồi recalc một lần.
   */
  private async writeComponentOutLogs(
    tx: any,
    product: any,
    sourceBranchId: number,
    quantity: number,
    actualComponents:
      | { componentProductId: number; actualGrams: number }[]
      | undefined,
    ref: { id: number; code: string; transactionDate: Date },
    actor?: InventoryLogActor,
  ): Promise<{
    pairs: { productId: number; branchId: number }[];
    materialValue: number;
  }> {
    const pairs: { productId: number; branchId: number }[] = [];
    let materialValue = 0;

    for (const comp of product.comboComponents) {
      const componentProduct = comp.componentProduct;
      const componentWeight = componentProduct.weight
        ? Number(componentProduct.weight)
        : 0;
      const componentWeightUnit = componentProduct.weightUnit || 'g';
      const weightInGrams =
        componentWeightUnit === 'kg' ? componentWeight * 1000 : componentWeight;

      const actual = actualComponents?.find(
        (a) => a.componentProductId === comp.componentProductId,
      );

      // PIECE-LIKE: trừ kho theo số đơn vị trực tiếp. Áp dụng cho
      // inputMode='piece', inputMode='carton' (thùng — quantity=1/N), LẪN
      // trường hợp component không có weight (weightInGrams===0) — tránh
      // chia 0 / throw oan ở nhánh gram.
      // CARTON: comp.quantity = 1/N → comp.quantity × quantity = số thùng
      // tiêu hao (phân số, KHÔNG làm tròn để các đợt cộng dồn khít nhau).
      const isPieceLike =
        comp.inputMode === 'piece' ||
        comp.inputMode === 'carton' ||
        weightInGrams === 0;

      const unitsToDeduct = isPieceLike
        ? actual
          ? actual.actualGrams // field này chứa số đơn vị thực tế khi piece/carton
          : Number(comp.quantity) * Number(quantity)
        : (actual
            ? actual.actualGrams
            : Number(comp.quantity) * Number(quantity)) / weightInGrams;

      const sourceInventory = await tx.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: sourceBranchId,
          },
        },
      });

      if (!sourceInventory) {
        throw new NotFoundException(
          `Inventory for component ${componentProduct.name} not found at source branch`,
        );
      }

      if (Number(sourceInventory.onHand) < unitsToDeduct) {
        throw new BadRequestException(
          `Insufficient inventory for component ${componentProduct.name}. Required: ${unitsToDeduct}, Available: ${sourceInventory.onHand}`,
        );
      }

      await tx.inventoryLog.create({
        data: {
          productId: comp.componentProductId,
          productCode: componentProduct.code,
          productName: componentProduct.name,
          branchId: sourceBranchId,
          branchName: sourceInventory.branchName || '',
          transactionType: 'PRODUCTION_OUT',
          refCode: ref.code,
          refType: 'production',
          refId: ref.id,
          quantity: -unitsToDeduct,
          costPrice: Number(sourceInventory.cost),
          transactionPrice: null,
          transactionDate: ref.transactionDate,
          ...buildInventoryLogBase(actor),
        },
      });

      materialValue += unitsToDeduct * Number(sourceInventory.cost);
      pairs.push({
        productId: comp.componentProductId,
        branchId: sourceBranchId,
      });
    }

    return { pairs, materialValue: Math.round(materialValue * 100) / 100 };
  }

  /** Ghi PRODUCTION_IN cho thành phẩm tại kho đích. KHÔNG recalc. */
  private async writeFinishedInLog(
    tx: any,
    product: { id: number; code: string; name: string },
    destinationBranchId: number,
    quantity: number,
    ref: { id: number; code: string; transactionDate: Date },
    actor?: InventoryLogActor,
  ): Promise<{ productId: number; branchId: number }> {
    const destInventory = await tx.inventory.findUnique({
      where: {
        productId_branchId: {
          productId: product.id,
          branchId: destinationBranchId,
        },
      },
    });

    if (!destInventory) {
      // Khởi tạo bản ghi tồn (onHand=0) — giá trị thật sẽ do recalc set lại
      // theo Σ log active. Tạo trước để recalc có chỗ ghi.
      const destBranch = await tx.branch.findUnique({
        where: { id: destinationBranchId },
      });
      await tx.inventory.create({
        data: {
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          branchId: destinationBranchId,
          branchName: destBranch?.name || '',
          cost: 0,
          onHand: 0,
          totalWeight: 0,
          reserved: 0,
          onOrder: 0,
          minQuality: 0,
          maxQuality: 0,
        },
      });
    }

    await tx.inventoryLog.create({
      data: {
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        branchId: destinationBranchId,
        branchName: destInventory?.branchName || '',
        transactionType: 'PRODUCTION_IN',
        refCode: ref.code,
        refType: 'production',
        refId: ref.id,
        quantity: Number(quantity),
        costPrice: destInventory ? Number(destInventory.cost) : 0,
        transactionPrice: null,
        transactionDate: ref.transactionDate,
        ...buildInventoryLogBase(actor),
      },
    });

    return { productId: product.id, branchId: destinationBranchId };
  }

  // LOG-TRUTH: phiếu đã được set status=3 (CANCELLED) TRƯỚC khi gọi hàm này,
  // nên active-finder (status!=3) tự loại mọi log PRODUCTION_OUT/IN của phiếu
  // khỏi Σ. Chỉ cần recalc onHand cho component@source + thành phẩm@dest →
  // tự khôi phục đúng số đã trừ/cộng (KHÔNG cộng/trừ tay, KHÔNG ghi log đối ứng).
  private async reverseInventoryChanges(
    tx: any,
    product: any,
    sourceBranchId: number,
    destinationBranchId: number,
    snapshotComponents: { componentProductId: number }[] = [],
  ) {
    const affectedPairs: { productId: number; branchId: number }[] = [
      { productId: product.id, branchId: destinationBranchId },
    ];
    // Thành phần đã xuất lưu trên phiếu (snapshot) + công thức hiện tại — để
    // không bỏ sót khi công thức đã bị sửa sau khi sản xuất.
    const componentIds = new Set([
      ...snapshotComponents.map((c) => c.componentProductId),
      ...product.comboComponents.map((c: any) => c.componentProductId),
    ]);
    for (const componentProductId of componentIds) {
      affectedPairs.push({
        productId: componentProductId,
        branchId: sourceBranchId,
      });
    }
    await recalcOnHandForPairs(tx, affectedPairs);
  }

  // ══════════════════════════════════════════════════════════════════════
  // GỬI SẢN XUẤT Ở NHÀ MÁY NGOÀI (isExternal = true)
  //   1 Phiếu tạm → 4 Đã gửi (trừ NVL, chụp giá vốn NVL = hàng NCC đang giữ)
  //               → 2 Hoàn thành (nhập thành phẩm, phí sản xuất vào nợ NCC)
  //   Hủy (3) sau khi đã gửi: chỉ người có quyền xóa phiếu sản xuất (admin).
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Kiểm tra NCC / nhà máy và quy đổi phí sản xuất ra VND. Trả về các cột cần
   * ghi vào Production (dùng chung cho tạo và sửa phiếu tạm).
   */
  private async resolveExternalFields(
    db: Prisma.TransactionClient | PrismaService,
    input: {
      supplierId?: number;
      factoryId?: number | null;
      feeCurrency?: string;
      processingFee?: number;
      feeForeignAmount?: number;
      feeExchangeRate?: number;
    },
  ) {
    if (!input.supplierId) {
      throw new BadRequestException(
        'Vui lòng chọn nhà cung cấp (đơn vị ghi nhận phí sản xuất)',
      );
    }
    const [supplier, factory] = await Promise.all([
      db.supplier.findUnique({ where: { id: input.supplierId } }),
      input.factoryId
        ? db.factory.findUnique({ where: { id: input.factoryId } })
        : null,
    ]);
    if (!supplier) throw new BadRequestException('Không tìm thấy nhà cung cấp');
    if (input.factoryId && !factory) {
      throw new BadRequestException('Không tìm thấy nhà máy');
    }
    if (factory?.supplierId && factory.supplierId !== supplier.id) {
      throw new BadRequestException('Nhà máy không thuộc nhà cung cấp đã chọn');
    }

    const feeCurrency = input.feeCurrency === 'CNY' ? 'CNY' : 'VND';
    if (
      feeCurrency === 'CNY' &&
      Number(input.feeForeignAmount ?? 0) > 0 &&
      Number(input.feeExchangeRate ?? 0) <= 0
    ) {
      throw new BadRequestException('Vui lòng nhập tỷ giá cho phí sản xuất');
    }
    const processingFee = productionFeeInVnd({
      currency: feeCurrency,
      amount: input.processingFee,
      foreignAmount: input.feeForeignAmount,
      exchangeRate: input.feeExchangeRate,
    });

    return {
      supplierId: supplier.id,
      factoryId: factory?.id ?? null,
      feeCurrency,
      processingFee,
      feeForeignAmount:
        feeCurrency === 'CNY' ? Number(input.feeForeignAmount ?? 0) : null,
      feeExchangeRate:
        feeCurrency === 'CNY' ? Number(input.feeExchangeRate ?? 0) : null,
    };
  }

  private async loadExternalProduction(db: any, id: number) {
    const production = await db.production.findUnique({
      where: { id },
      include: { components: true },
    });
    if (!production) {
      throw new NotFoundException('Không tìm thấy phiếu gửi sản xuất');
    }
    if (!production.isExternal) {
      throw new BadRequestException('Phiếu này không phải phiếu gửi sản xuất');
    }
    return production;
  }

  /** Phiếu tạm → Đã gửi: xuất nguyên liệu khỏi kho, gửi sang nhà máy. */
  async sendToFactory(id: number, dto: SendProductionDto, userId: number) {
    const production = await this.loadExternalProduction(this.prisma, id);
    if (production.status !== PRODUCTION_STATUS.DRAFT) {
      throw new BadRequestException('Chỉ gửi hàng được từ phiếu tạm');
    }
    if (!production.supplierId) {
      throw new BadRequestException('Phiếu chưa chọn nhà cung cấp');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const actor = buildInventoryLogActor(userId, user?.name || user?.email);
    const sentDate = dto.sentDate ? new Date(dto.sentDate) : new Date();

    // Ưu tiên số người dùng vừa sửa; không có thì dùng số đã lưu ở phiếu tạm;
    // vẫn không có thì trừ đúng định mức công thức.
    const actualComponents = dto.components?.length
      ? dto.components
      : production.components.length
        ? production.components.map((c: any) => ({
            componentProductId: c.componentProductId,
            formulaGrams: Number(c.formulaGrams),
            actualGrams: Number(c.actualGrams),
          }))
        : undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const { product } = await this.loadProductWithFormula(
        tx,
        production.productId,
        production.formulaId,
      );
      if (!product) throw new NotFoundException('Không tìm thấy thành phẩm');
      if (product.comboComponents.length === 0) {
        throw new BadRequestException(
          'Thành phẩm chưa có công thức nguyên liệu, không thể gửi sản xuất',
        );
      }

      const { pairs, materialValue } = await this.writeComponentOutLogs(
        tx,
        product,
        production.sourceBranchId,
        Number(production.quantity),
        actualComponents,
        { id: production.id, code: production.code, transactionDate: sentDate },
        actor,
      );
      await recalcOnHandForPairs(tx, pairs);

      // Lưu lại đúng số đã xuất để chi tiết phiếu / hủy phiếu đọc được.
      await tx.productionComponent.deleteMany({ where: { productionId: id } });
      await tx.productionComponent.createMany({
        data: this.buildComponentRows(
          id,
          product,
          Number(production.quantity),
          actualComponents,
        ),
      });

      return tx.production.update({
        where: { id },
        data: {
          status: PRODUCTION_STATUS.SENT,
          sentDate,
          materialValue,
          totalCost: materialValue + Number(production.processingFee),
          autoDeductComponents: true,
        },
        include: { components: true, ...PRODUCTION_PARTNER_INCLUDE },
      });
    });

    await this.auditFactory('PRODUCTION_FACTORY_SEND', updated, userId, {
      materialValue: Number(updated.materialValue),
    });
    return updated;
  }

  /**
   * Đã gửi → Hoàn thành: nhập thành phẩm vào kho đích, phí sản xuất vào nợ
   * NCC. Có `newCost` (người dùng đã xác nhận) thì ghi luôn giá vốn.
   */
  async receiveFromFactory(
    id: number,
    dto: ReceiveProductionDto,
    userId: number,
  ) {
    const production = await this.loadExternalProduction(this.prisma, id);
    if (production.status !== PRODUCTION_STATUS.SENT) {
      throw new BadRequestException('Chỉ nhận hàng cho phiếu đã gửi');
    }
    const receivedQuantity =
      dto.receivedQuantity ?? Number(production.quantity);
    if (receivedQuantity <= 0) {
      throw new BadRequestException('Số lượng nhận phải lớn hơn 0');
    }
    const completedDate = dto.completedDate
      ? new Date(dto.completedDate)
      : new Date();
    // So theo NGÀY: form chỉ chọn ngày nên giờ-phút không dùng để chặn.
    if (
      production.sentDate &&
      completedDate.toISOString().slice(0, 10) <
        production.sentDate.toISOString().slice(0, 10)
    ) {
      throw new BadRequestException('Ngày nhận không được trước ngày gửi');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const actor = buildInventoryLogActor(userId, user?.name || user?.email);

    const updated = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: production.productId },
        select: { id: true, code: true, name: true },
      });
      if (!product) throw new NotFoundException('Không tìm thấy thành phẩm');

      const pair = await this.writeFinishedInLog(
        tx,
        product,
        production.destinationBranchId,
        receivedQuantity,
        {
          id: production.id,
          code: production.code,
          transactionDate: completedDate,
        },
        actor,
      );
      await recalcOnHandForPairs(tx, [pair]);

      const costData =
        dto.newCost != null && dto.newCost > 0
          ? await this.writeFinishedCost(
              tx,
              production,
              dto.newCost,
              dto.costScope,
            )
          : {};

      const result = await tx.production.update({
        where: { id },
        data: {
          status: PRODUCTION_STATUS.COMPLETED,
          completedDate,
          receivedQuantity,
          totalCost:
            Number(production.materialValue) + Number(production.processingFee),
          ...costData,
        },
        include: { components: true, ...PRODUCTION_PARTNER_INCLUDE },
      });

      // Phí sản xuất bắt đầu tính vào nợ NCC từ lúc hoàn thành.
      await recalcSupplierDebt(tx, production.supplierId);
      return result;
    });

    await this.auditFactory('PRODUCTION_FACTORY_RECEIVE', updated, userId, {
      receivedQuantity,
      processingFee: Number(updated.processingFee),
      appliedUnitCost:
        updated.appliedUnitCost != null
          ? Number(updated.appliedUnitCost)
          : null,
    });
    return updated;
  }

  /**
   * Xem trước giá thành + giá vốn bình quân đề xuất. Dùng được cả TRƯỚC khi
   * nhận hàng (phiếu Đã gửi, truyền SL dự kiến nhận) lẫn sau khi hoàn thành.
   */
  async getFactoryCostPreview(id: number, receivedQuantity?: number) {
    const production = await this.loadExternalProduction(this.prisma, id);
    const completed = production.status === PRODUCTION_STATUS.COMPLETED;
    if (!completed && production.status !== PRODUCTION_STATUS.SENT) {
      throw new BadRequestException(
        'Chỉ tính giá thành cho phiếu đã gửi hoặc đã hoàn thành',
      );
    }

    const received = completed
      ? Number(production.receivedQuantity ?? production.quantity)
      : (receivedQuantity ?? Number(production.quantity));
    const totalCost =
      Number(production.materialValue) + Number(production.processingFee);
    const unitCost =
      received > 0 ? Math.round((totalCost / received) * 1e6) / 1e6 : 0;

    const inventories = await this.prisma.inventory.findMany({
      where: { productId: production.productId },
      select: { branchId: true, onHand: true, cost: true },
    });
    const dest = inventories.find(
      (i) => i.branchId === production.destinationBranchId,
    );
    const onHand = dest ? Number(dest.onHand) : 0;
    const oldCost = dest ? Number(dest.cost) : 0;
    // Trước khi nhận: toàn bộ tồn hiện có là "tồn khác". Sau khi nhận: tồn
    // hiện có đã gồm lô này nên trừ ra.
    const { otherQuantity, proposedCost } = computeWeightedAverageCost({
      otherQuantity: completed ? onHand - received : onHand,
      oldCost,
      receivedQuantity: received,
      unitCost,
    });

    return {
      productionId: production.id,
      productName: production.productName,
      receiveBranchId: production.destinationBranchId,
      receiveBranchName: production.destinationBranchName,
      materialValue: Number(production.materialValue),
      processingFee: Number(production.processingFee),
      totalCost,
      receivedQuantity: received,
      unitCost,
      onHand,
      oldCost,
      otherQuantity,
      proposedCost,
      branchCount: inventories.length,
      applied: !!production.costAppliedAt,
      appliedUnitCost:
        production.appliedUnitCost != null
          ? Number(production.appliedUnitCost)
          : null,
    };
  }

  /** Áp giá vốn thành phẩm sau khi đã hoàn thành (nếu lúc nhận hàng bỏ qua). */
  async applyFactoryCost(
    id: number,
    dto: ApplyProductionCostDto,
    userId: number,
  ) {
    if (dto.newCost <= 0) {
      throw new BadRequestException('Giá vốn mới phải lớn hơn 0');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const production = await this.loadExternalProduction(tx, id);
      if (production.status !== PRODUCTION_STATUS.COMPLETED) {
        throw new BadRequestException('Chỉ áp giá vốn cho phiếu đã hoàn thành');
      }
      if (production.costAppliedAt) {
        throw new BadRequestException('Phiếu này đã áp giá vốn rồi');
      }
      if (dto.expectedOldCost != null) {
        const dest = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: production.productId,
              branchId: production.destinationBranchId,
            },
          },
          select: { cost: true },
        });
        if (Math.abs(Number(dest?.cost ?? 0) - dto.expectedOldCost) > 0.005) {
          throw new ConflictException(
            'Giá vốn hiện tại đã thay đổi, vui lòng xem lại trước khi áp',
          );
        }
      }
      const costData = await this.writeFinishedCost(
        tx,
        production,
        dto.newCost,
        dto.scope,
      );
      return tx.production.update({
        where: { id },
        data: costData,
        include: { components: true, ...PRODUCTION_PARTNER_INCLUDE },
      });
    });

    await this.auditFactory('PRODUCTION_FACTORY_APPLY_COST', updated, userId, {
      newCostAmount: dto.newCost,
      scope: dto.scope || 'receiveBranch',
    });
    return updated;
  }

  /**
   * Hủy phiếu gửi sản xuất (kể cả đã gửi / đã hoàn thành) — quyền admin.
   * Đổi trạng thái là đủ để ACTIVE_FINDERS void mọi log của phiếu; chỉ cần
   * dẫn xuất lại tồn và nợ NCC. Giá vốn đã áp KHÔNG tự hoàn lại.
   */
  async cancelSentProduction(
    id: number,
    dto: CancelSentProductionDto,
    userId: number,
  ) {
    const production = await this.loadExternalProduction(this.prisma, id);
    if (production.status === PRODUCTION_STATUS.CANCELLED) {
      throw new BadRequestException('Phiếu đã hủy');
    }
    const previousStatus = production.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.production.update({
        where: { id },
        data: { status: PRODUCTION_STATUS.CANCELLED },
        include: { components: true, ...PRODUCTION_PARTNER_INCLUDE },
      });

      if (previousStatus !== PRODUCTION_STATUS.DRAFT) {
        const finishedPair = {
          productId: production.productId,
          branchId: production.destinationBranchId,
        };
        await recalcOnHandForPairs(tx, [
          ...production.components.map((c: any) => ({
            productId: c.componentProductId,
            branchId: production.sourceBranchId,
          })),
          finishedPair,
        ]);
        if (previousStatus === PRODUCTION_STATUS.COMPLETED) {
          const inv = await tx.inventory.findUnique({
            where: { productId_branchId: finishedPair },
            select: { onHand: true },
          });
          if (inv && Number(inv.onHand) < 0) {
            throw new BadRequestException(
              'Thành phẩm của phiếu đã được bán/xuất, không thể hủy phiếu',
            );
          }
        }
      }

      if (production.supplierId) {
        await recalcSupplierDebt(tx, production.supplierId);
      }
      return result;
    });

    await this.auditFactory('PRODUCTION_FACTORY_CANCEL', updated, userId, {
      previousStatus,
      reason: dto.reason || null,
      costWasApplied: !!production.costAppliedAt,
    });
    return updated;
  }

  /** Ghi giá vốn thành phẩm (kho nhận hoặc mọi chi nhánh). Trả cột cần lưu. */
  private async writeFinishedCost(
    tx: any,
    production: {
      productId: number;
      destinationBranchId: number;
    },
    newCost: number,
    scope: 'receiveBranch' | 'allBranches' | undefined,
  ) {
    const where =
      scope === 'allBranches'
        ? { productId: production.productId }
        : {
            productId: production.productId,
            branchId: production.destinationBranchId,
          };
    const { count } = await tx.inventory.updateMany({
      where,
      data: { cost: newCost },
    });
    if (count === 0) {
      throw new BadRequestException('Thành phẩm chưa có tồn kho tại kho nhận');
    }
    return {
      costAppliedAt: new Date(),
      appliedUnitCost: newCost,
    };
  }

  /** Dòng ProductionComponent theo công thức + số thực tế (nếu có). */
  private buildComponentRows(
    productionId: number,
    product: any,
    quantity: number,
    actualComponents?: {
      componentProductId: number;
      formulaGrams?: number;
      actualGrams: number;
    }[],
  ) {
    return product.comboComponents.map((comp: any) => {
      const componentProduct = comp.componentProduct;
      const weightInGrams =
        componentProduct?.weightUnit === 'kg'
          ? Number(componentProduct.weight) * 1000
          : Number(componentProduct?.weight || 0);
      const formulaGrams = Number(comp.quantity) * quantity;
      const actual = actualComponents?.find(
        (a) => a.componentProductId === comp.componentProductId,
      );
      const actualGrams = actual ? Number(actual.actualGrams) : formulaGrams;
      return {
        productionId,
        componentProductId: comp.componentProductId,
        componentCode: componentProduct?.code || '',
        componentName: componentProduct?.name || '',
        formulaGrams,
        actualGrams,
        // weight=0 (piece/carton): actualGrams chính là số đơn vị/thùng
        unitsDeducted:
          weightInGrams > 0 ? actualGrams / weightInGrams : actualGrams,
        inputMode: comp.inputMode ?? null,
      };
    });
  }

  private async auditFactory(
    actionCode: string,
    production: any,
    userId: number,
    params: Record<string, any> = {},
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    await this.auditLogsService.create({
      actionType: 'POST',
      actionCode,
      entityType: 'productions',
      entityId: production.id.toString(),
      entityCode: production.code,
      category: getCategoryFromActionCode(actionCode),
      severity: getSeverityFromActionCode(actionCode),
      snapshot: {
        ...this.buildProductionSnapshot(production),
        factory: production.factory?.name ?? null,
        supplier: production.supplier?.name ?? null,
        ...params,
      },
      message: renderAuditMessage(actionCode, {
        productionCode: production.code,
        ...params,
      }),
      messageTemplate: actionCode,
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: production.sourceBranchId,
    });
  }

  /**
   * Nạp thành phẩm với `comboComponents` = thành phần của công thức đã chọn
   * (không chọn → công thức mặc định). Logic tính chi phí / trừ kho phía sau
   * đều đọc product.comboComponents nên giữ nguyên.
   */
  private async loadProductWithFormula(
    db: Prisma.TransactionClient,
    productId: number,
    formulaId?: number | null,
  ) {
    const product = await db.product.findUnique({
      where: { id: productId },
      include: {
        comboComponents: {
          where: formulaId ? { formulaId } : DEFAULT_COMPONENTS_WHERE,
          include: { componentProduct: true },
        },
        formulas: {
          where: formulaId ? { id: formulaId } : { isDefault: true },
          select: { id: true, name: true },
        },
      },
    });
    if (product && formulaId && product.formulas.length === 0) {
      throw new BadRequestException('Công thức không thuộc sản phẩm này');
    }
    return { product, formula: product?.formulas[0] ?? null };
  }

  private buildProductionSnapshot(production: any, components?: any[]) {
    return {
      code: production.code,
      status: production.status,
      productId: production.productId,
      productCode: production.productCode,
      productName: production.productName,
      quantity: Number(production.quantity),
      totalCost: Number(production.totalCost),
      sourceBranchName: production.sourceBranchName,
      destinationBranchName: production.destinationBranchName,
      note: production.note,
      autoDeductComponents: production.autoDeductComponents,
      manufacturedDate: production.manufacturedDate,
      createdByName: production.createdByName,
      formulaName: production.formulaName,
      // Bổ sung danh sách nguyên liệu đã xuất (comboComponents) để truy vết
      // trực tiếp trên audit log (trước đây chỉ có thành phẩm → không biết xuất
      // bao nhiêu nguyên liệu A, B, C). Lấy từ production.components (include)
      // hoặc từ componentDetails truyền vào khi tạo.
      components: (components || production.components || []).map((c: any) => ({
        componentCode: c.componentCode,
        componentName: c.componentName,
        actualGrams: c.actualGrams,
        unitsDeducted: c.unitsDeducted,
      })),
    };
  }
}
