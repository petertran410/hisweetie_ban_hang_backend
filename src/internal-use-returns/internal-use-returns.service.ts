import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';
import {
  buildInventoryLogActor,
  buildInventoryLogBase,
  InventoryLogActor,
} from '../common/inventory-log.util';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import {
  recalcConditionBucketsForPairs,
  writeConditionLogs,
} from '../common/stock-condition-onhand.util';
import {
  ConfirmInternalUseReturnDto,
  CreateInternalUseReturnDto,
  INTERNAL_USE_RETURN_STATUS,
  INTERNAL_USE_RETURN_STATUS_LABELS,
  InternalUseReturnQueryDto,
  UpdateInternalUseReturnDto,
} from './dto';

@Injectable()
export class InternalUseReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
    private readonly larkProductSync: LarkProductSyncService,
  ) {}

  private async generateCode(tx: any): Promise<string> {
    const last = await tx.internalUseReturn.findFirst({
      where: { code: { startsWith: 'THXDNB' } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const sequence = last ? Number(last.code.slice(-6)) + 1 : 1;
    return `THXDNB${String(sequence).padStart(6, '0')}`;
  }

  private normalizeMonthDate(value?: string | Date | null): Date | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Lô cận date không hợp lệ');
    }
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  private buildWhere(query: InternalUseReturnQueryDto): Prisma.InternalUseReturnWhereInput {
    const where: Prisma.InternalUseReturnWhereInput = {};

    if (query.internalUseId) where.internalUseId = query.internalUseId;
    if (query.branchIds?.length) where.branchId = { in: query.branchIds };
    else if (query.branchId) where.branchId = query.branchId;
    if (query.status) where.status = query.status;

    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        {
          internalUse: {
            code: { contains: query.search, mode: 'insensitive' },
          },
        },
      ];
    }

    if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
      if (query.toDate) where.createdAt.lte = new Date(query.toDate);
    }

    return where;
  }

  private async lockInternalUse(tx: any, internalUseId: number): Promise<any> {
    await tx.$queryRaw`
      SELECT id FROM "internal_uses"
      WHERE id = ${internalUseId}
      FOR UPDATE
    `;

    const internalUse = await tx.internalUse.findUnique({
      where: { id: internalUseId },
      include: {
        details: true,
        branch: { select: { id: true, name: true } },
      },
    });

    if (!internalUse) {
      throw new NotFoundException('Không tìm thấy phiếu xuất dùng nội bộ');
    }
    if (internalUse.status !== 2) {
      throw new BadRequestException(
        'Chỉ được trả hàng từ phiếu xuất dùng nội bộ đã hoàn thành',
      );
    }
    return internalUse;
  }

  private async getAlreadyRequested(
    tx: any,
    internalUseId: number,
    excludeReturnId?: number,
  ): Promise<Map<number, number>> {
    const rows = await tx.internalUseReturn.findMany({
      where: {
        internalUseId,
        status: { not: INTERNAL_USE_RETURN_STATUS.CANCELLED },
        ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}),
      },
      include: { details: true },
    });
    const result = new Map<number, number>();
    for (const row of rows) {
      for (const detail of row.details) {
        result.set(
          detail.internalUseDetailId,
          (result.get(detail.internalUseDetailId) || 0) +
            Number(detail.requestQuantity),
        );
      }
    }
    return result;
  }

  private buildSourceMap(internalUse: any): Map<number, any> {
    return new Map(internalUse.details.map((detail: any) => [detail.id, detail]));
  }

  private async buildDetails(
    tx: any,
    internalUse: any,
    input: Array<{ internalUseDetailId: number; requestQuantity: number; note?: string }>,
    excludeReturnId?: number,
  ) {
    const alreadyRequested = await this.getAlreadyRequested(
      tx,
      internalUse.id,
      excludeReturnId,
    );
    const sourceMap = this.buildSourceMap(internalUse);
    const seen = new Set<number>();
    const valid = input.filter((detail) => Number(detail.requestQuantity) > 0);

    if (valid.length === 0) {
      throw new BadRequestException('Chưa nhập số lượng hàng cần trả');
    }

    return valid.map((detail) => {
      const source = sourceMap.get(detail.internalUseDetailId);
      if (!source) {
        throw new BadRequestException(
          `Dòng xuất dùng nội bộ #${detail.internalUseDetailId} không thuộc phiếu ${internalUse.code}`,
        );
      }
      if (seen.has(source.id)) {
        throw new BadRequestException(
          `Dòng sản phẩm ${source.productName} bị lặp trong phiếu trả`,
        );
      }
      seen.add(source.id);

      const requestQuantity = Number(detail.requestQuantity);
      const remaining =
        Number(source.quantity) - (alreadyRequested.get(source.id) || 0);
      if (requestQuantity > remaining) {
        throw new BadRequestException(
          `Sản phẩm ${source.productName}: số lượng trả ${requestQuantity} vượt quá còn lại ${remaining}`,
        );
      }

      return {
        internalUseDetailId: source.id,
        productId: source.productId,
        productCode: source.productCode,
        productName: source.productName,
        unit: source.unit,
        issuedQuantity: source.quantity,
        sourceConditionType: source.conditionType || 'normal',
        sourceSoldExpiryDate: source.soldExpiryDate,
        requestQuantity,
        note: detail.note || null,
      };
    });
  }

  private async getActor(
    tx: any,
    userId: number,
  ): Promise<{ id: number; name: string; email?: string }> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });
    return user || { id: userId, name: 'System' };
  }

  private async audit(
    actionCode: string,
    message: string,
    entity: any,
    userId: number,
    severity: 'info' | 'warning' = 'info',
    snapshot?: any,
  ) {
    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode,
      entityType: 'internal_use_returns',
      entityId: String(entity.id),
      entityCode: entity.code,
      category: 'internal_use',
      severity,
      snapshot: snapshot || { code: entity.code, status: entity.status },
      message,
      messageTemplate: actionCode,
      userId,
      userName: actor?.name || actor?.email || 'System',
      branchId: entity.branchId || undefined,
    });
  }

  async findAll(query: InternalUseReturnQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const where = this.buildWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.internalUseReturn.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          internalUse: { select: { id: true, code: true } },
          branch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          receivedBy: { select: { id: true, name: true } },
          details: true,
        },
      }),
      this.prisma.internalUseReturn.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    const result = await this.prisma.internalUseReturn.findUnique({
      where: { id },
      include: {
        internalUse: {
          select: {
            id: true,
            code: true,
            status: true,
            transDate: true,
            purpose: { select: { name: true } },
          },
        },
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
        details: {
          include: {
            internalUseDetail: true,
            product: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });
    if (!result) throw new NotFoundException('Không tìm thấy phiếu trả');
    return result;
  }

  async getReturnable(internalUseId: number) {
    return this.prisma.$transaction(async (tx) => {
      const internalUse = await this.lockInternalUse(tx, internalUseId);
      const alreadyRequested = await this.getAlreadyRequested(tx, internalUseId);

      return {
        internalUseId: internalUse.id,
        internalUseCode: internalUse.code,
        branchId: internalUse.branchId,
        branchName: internalUse.branchName,
        details: internalUse.details
          .map((detail: any) => ({
            internalUseDetailId: detail.id,
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            unit: detail.unit,
            issuedQuantity: Number(detail.quantity),
            remainingQuantity: Math.max(
              0,
              Number(detail.quantity) -
                (alreadyRequested.get(detail.id) || 0),
            ),
            conditionType: detail.conditionType || 'normal',
            soldExpiryDate: detail.soldExpiryDate,
          }))
          .filter((detail: any) => detail.remainingQuantity > 0),
      };
    });
  }

  async create(dto: CreateInternalUseReturnDto, userId: number) {
    const created = await this.prisma.$transaction(async (tx) => {
      const internalUse = await this.lockInternalUse(tx, dto.internalUseId);
      const details = await this.buildDetails(
        tx,
        internalUse,
        dto.details || [],
      );
      const actor = await this.getActor(tx, userId);
      const isDraft = dto.isDraft ?? true;
      const status = isDraft
        ? INTERNAL_USE_RETURN_STATUS.REQUEST_DRAFT
        : INTERNAL_USE_RETURN_STATUS.REQUEST;
      const code = await this.generateCode(tx);
      const totalRequestQuantity = details.reduce(
        (sum, detail) => sum + Number(detail.requestQuantity),
        0,
      );

      return tx.internalUseReturn.create({
        data: {
          code,
          internalUseId: internalUse.id,
          branchId: internalUse.branchId,
          status,
          statusValue: INTERNAL_USE_RETURN_STATUS_LABELS[status],
          totalRequestQuantity,
          note: dto.note || null,
          createdBy: userId,
          createdByName: actor.name,
          details: { create: details },
        },
        include: { details: true },
      });
    });

    await this.audit(
      'INTERNAL_USE_RETURN_CREATE',
      `Tạo phiếu trả xuất dùng nội bộ ${created.code}`,
      created,
      userId,
    );
    return this.findOne(created.id);
  }

  async updateStep1(
    id: number,
    dto: UpdateInternalUseReturnDto,
    userId: number,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.internalUseReturn.findUnique({
        where: { id },
        include: { details: true },
      });
      if (!current) throw new NotFoundException('Không tìm thấy phiếu trả');
      if (
        current.status !== INTERNAL_USE_RETURN_STATUS.REQUEST_DRAFT &&
        current.status !== INTERNAL_USE_RETURN_STATUS.REQUEST
      ) {
        throw new BadRequestException(
          'Phiếu trả không ở trạng thái cho phép chỉnh sửa',
        );
      }

      const internalUse = await this.lockInternalUse(tx, current.internalUseId);
      const currentDetailsById = new Map(
        current.details.map((detail: any) => [detail.id, detail]),
      );
      const details = await this.buildDetails(
        tx,
        internalUse,
        (dto.details || []).map((detail) => {
          const currentDetail = currentDetailsById.get(detail.detailId);
          if (!currentDetail) {
            throw new BadRequestException(
              `Không tìm thấy chi tiết phiếu trả #${detail.detailId}`,
            );
          }
          return {
            // detailId của update-step1 là ID dòng hiện tại trên phiếu trả;
            // chuyển qua ID dòng xuất gốc trước khi kiểm tra thuộc InternalUse.
            internalUseDetailId: currentDetail.internalUseDetailId,
            requestQuantity: detail.requestQuantity,
            note: detail.note,
          };
        }),
        id,
      );
      const isDraft = dto.isDraft ?? false;
      const status = isDraft
        ? INTERNAL_USE_RETURN_STATUS.REQUEST_DRAFT
        : INTERNAL_USE_RETURN_STATUS.REQUEST;
      const totalRequestQuantity = details.reduce(
        (sum, detail) => sum + Number(detail.requestQuantity),
        0,
      );

      await tx.internalUseReturnDetail.deleteMany({
        where: { internalUseReturnId: id },
      });
      await tx.internalUseReturn.update({
        where: { id },
        data: {
          status,
          statusValue: INTERNAL_USE_RETURN_STATUS_LABELS[status],
          totalRequestQuantity,
          note: dto.note ?? current.note,
          details: { create: details },
        },
      });
      return { id, code: current.code, branchId: current.branchId, status };
    });

    await this.audit(
      'INTERNAL_USE_RETURN_UPDATE',
      `Cập nhật phiếu trả xuất dùng nội bộ ${updated.code}`,
      updated,
      userId,
    );
    return this.findOne(id);
  }

  private resolveBuckets(
    detail: any,
    input: any,
  ): {
    goodQuantity: number;
    damagedQuantity: number;
    nearExpiryQuantity: number;
    confirmedQuantity: number;
    nearExpiryDate: Date | null;
  } {
    const hasExplicitBuckets =
      input.goodQuantity !== undefined ||
      input.damagedQuantity !== undefined ||
      input.nearExpiryQuantity !== undefined;

    let goodQuantity = Number(input.goodQuantity ?? 0);
    let damagedQuantity = Number(input.damagedQuantity ?? 0);
    let nearExpiryQuantity = Number(input.nearExpiryQuantity ?? 0);

    if (!hasExplicitBuckets) {
      if (detail.sourceConditionType === 'damaged') {
        damagedQuantity = Number(detail.requestQuantity);
      } else if (detail.sourceConditionType === 'near_expiry') {
        nearExpiryQuantity = Number(detail.requestQuantity);
      } else {
        goodQuantity = Number(detail.requestQuantity);
      }
    }

    const values = [goodQuantity, damagedQuantity, nearExpiryQuantity];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new BadRequestException(
        `Số lượng thực nhận của ${detail.productName} không hợp lệ`,
      );
    }

    const confirmedQuantity =
      goodQuantity + damagedQuantity + nearExpiryQuantity;
    if (confirmedQuantity > Number(detail.requestQuantity)) {
      throw new BadRequestException(
        `Sản phẩm ${detail.productName}: số lượng thực nhận vượt quá số lượng yêu cầu`,
      );
    }

    return {
      goodQuantity,
      damagedQuantity,
      nearExpiryQuantity,
      confirmedQuantity,
      nearExpiryDate:
        nearExpiryQuantity > 0
          ? this.normalizeMonthDate(input.nearExpiryDate)
          : null,
    };
  }

  async confirmStock(
    id: number,
    dto: ConfirmInternalUseReturnDto,
    userId: number,
  ) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.internalUseReturn.findUnique({
        where: { id },
        include: { details: true, branch: { select: { name: true } } },
      });
      if (!current) throw new NotFoundException('Không tìm thấy phiếu trả');
      if (
        current.status !== INTERNAL_USE_RETURN_STATUS.REQUEST &&
        current.status !== INTERNAL_USE_RETURN_STATUS.STOCK_DRAFT
      ) {
        throw new BadRequestException(
          'Phiếu trả không ở trạng thái cho phép nhập lại kho',
        );
      }

      const actor = await this.getActor(tx, userId);
      const inputById = new Map(
        (dto.details || []).map((detail) => [detail.detailId, detail]),
      );
      const resolved = new Map<number, any>();

      for (const detailId of inputById.keys()) {
        if (!current.details.some((detail) => detail.id === detailId)) {
          throw new BadRequestException(
            `Không tìm thấy chi tiết trả hàng ID ${detailId}`,
          );
        }
      }

      for (const detail of current.details) {
        const input: any = inputById.get(detail.id) || {};
        const buckets = this.resolveBuckets(detail, input);
        resolved.set(detail.id, { detail, input, buckets });
        await tx.internalUseReturnDetail.update({
          where: { id: detail.id },
          data: {
            confirmedQuantity: buckets.confirmedQuantity,
            goodQuantity: buckets.goodQuantity,
            damagedQuantity: buckets.damagedQuantity,
            nearExpiryQuantity: buckets.nearExpiryQuantity,
            nearExpiryDate: buckets.nearExpiryDate,
            note: input.note ?? detail.note,
          },
        });
      }

      if (dto.isDraft) {
        await tx.internalUseReturn.update({
          where: { id },
          data: {
            status: INTERNAL_USE_RETURN_STATUS.STOCK_DRAFT,
            statusValue:
              INTERNAL_USE_RETURN_STATUS_LABELS[
                INTERNAL_USE_RETURN_STATUS.STOCK_DRAFT
              ],
            note: dto.note ?? current.note,
            totalConfirmedQuantity: [...resolved.values()].reduce(
              (sum, item) => sum + item.buckets.confirmedQuantity,
              0,
            ),
          },
        });
        return { id, code: current.code, branchId: current.branchId };
      }

      for (const { detail, buckets } of resolved.values()) {
        if (buckets.confirmedQuantity <= 0) continue;
        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: current.branchId,
            },
          },
        });
        const costPrice = inventory ? Number(inventory.cost) : 0;

        await tx.inventory.upsert({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: current.branchId,
            },
          },
          update: { onHand: { increment: buckets.confirmedQuantity } },
          create: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: current.branchId,
            branchName: current.branch?.name || '',
            onHand: buckets.confirmedQuantity,
          },
        });

        const logActor = buildInventoryLogActor(userId, actor.name);
        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: current.branchId,
            branchName: current.branch?.name || '',
            transactionType: 'INTERNAL_USE_RETURN_IN',
            refCode: current.code,
            refType: 'internal_use_return',
            refId: current.id,
            quantity: buckets.confirmedQuantity,
            costPrice,
            transactionPrice: null,
            note: 'Nhập lại hàng trả từ xuất dùng nội bộ',
            ...buildInventoryLogBase(logActor),
          },
        });

        await writeConditionLogs(tx, {
          productId: detail.productId,
          productCode: detail.productCode,
          productName: detail.productName,
          branchId: current.branchId,
          branchName: current.branch?.name || '',
          refCode: current.code,
          refType: 'internal_use_return',
          refId: current.id,
          transactionType: 'INTERNAL_USE_RETURN_IN',
          costPrice,
          createdByName: actor.name,
          note: 'Nhập lại hàng trả từ xuất dùng nội bộ',
          damaged: buckets.damagedQuantity,
          nearExpiry: buckets.nearExpiryQuantity,
          nearExpiryDate: buckets.nearExpiryDate,
        });
        touchedProductIds.add(detail.productId);
      }

      const pairs = current.details.map((detail) => ({
        productId: detail.productId,
        branchId: current.branchId,
      }));
      await tx.internalUseReturn.update({
        where: { id },
        data: {
          status: INTERNAL_USE_RETURN_STATUS.STOCK_RECEIVED,
          statusValue:
            INTERNAL_USE_RETURN_STATUS_LABELS[
              INTERNAL_USE_RETURN_STATUS.STOCK_RECEIVED
            ],
          note: dto.note ?? current.note,
          totalConfirmedQuantity: [...resolved.values()].reduce(
            (sum, item) => sum + item.buckets.confirmedQuantity,
            0,
          ),
          receivedById: userId,
          receivedByName: actor.name,
          receivedAt: new Date(),
        },
      });
      await recalcOnHandForPairs(tx, pairs);
      await recalcConditionBucketsForPairs(tx, pairs);

      return { id, code: current.code, branchId: current.branchId };
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }
    await this.audit(
      'INTERNAL_USE_RETURN_STOCK_RECEIVED',
      `Nhập lại kho phiếu trả xuất dùng nội bộ ${result.code}`,
      result,
      userId,
      'info',
      { code: result.code, status: INTERNAL_USE_RETURN_STATUS.STOCK_RECEIVED },
    );
    return this.findOne(id);
  }

  async cancel(id: number, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.internalUseReturn.findUnique({
        where: { id },
        include: {
          details: true,
          branch: { select: { name: true } },
        },
      });
      if (!current) throw new NotFoundException('Không tìm thấy phiếu trả');
      if (current.status === INTERNAL_USE_RETURN_STATUS.CANCELLED) {
        throw new BadRequestException('Phiếu trả đã bị hủy');
      }

      if (current.status === INTERNAL_USE_RETURN_STATUS.STOCK_RECEIVED) {
        const actor = await this.getActor(tx, userId);
        const logActor = buildInventoryLogActor(userId, actor.name);
        for (const detail of current.details) {
          const quantity = Number(detail.confirmedQuantity);
          if (quantity <= 0) continue;
          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: current.branchId,
              branchName: current.branch?.name || '',
              transactionType: 'INTERNAL_USE_RETURN_CANCEL',
              refCode: current.code,
              refType: 'internal_use_return',
              refId: current.id,
              quantity: -quantity,
              costPrice: 0,
              transactionPrice: null,
              note: 'Hủy phiếu trả xuất dùng nội bộ',
              ...buildInventoryLogBase(logActor),
            },
          });
          touchedProductIds.add(detail.productId);
        }
      }

      await tx.internalUseReturn.update({
        where: { id },
        data: {
          status: INTERNAL_USE_RETURN_STATUS.CANCELLED,
          statusValue:
            INTERNAL_USE_RETURN_STATUS_LABELS[
              INTERNAL_USE_RETURN_STATUS.CANCELLED
            ],
        },
      });

      if (current.status === INTERNAL_USE_RETURN_STATUS.STOCK_RECEIVED) {
        const pairs = current.details.map((detail) => ({
          productId: detail.productId,
          branchId: current.branchId,
        }));
        await recalcOnHandForPairs(tx, pairs);
        await recalcConditionBucketsForPairs(tx, pairs);
      }

      return { id, code: current.code, branchId: current.branchId };
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }
    await this.audit(
      'INTERNAL_USE_RETURN_CANCEL',
      `Hủy phiếu trả xuất dùng nội bộ ${result.code}`,
      result,
      userId,
      'warning',
    );
    return this.findOne(id);
  }

  async exportReturns(
    query: InternalUseReturnQueryDto,
    res: Response,
    detailMode: boolean,
  ) {
    const where = this.buildWhere(query);
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet(
      detailMode ? 'Chi tiết trả xuất dùng NB' : 'Trả xuất dùng nội bộ',
    );
    sheet.columns = detailMode
      ? [
          { header: 'Mã phiếu trả', key: 'code', width: 20 },
          { header: 'Mã phiếu xuất', key: 'internalUseCode', width: 22 },
          { header: 'Chi nhánh', key: 'branch', width: 22 },
          { header: 'Trạng thái', key: 'status', width: 20 },
          { header: 'Mã hàng', key: 'productCode', width: 16 },
          { header: 'Tên hàng', key: 'productName', width: 34 },
          { header: 'SL đã xuất', key: 'issuedQuantity', width: 14 },
          { header: 'SL yêu cầu trả', key: 'requestQuantity', width: 16 },
          { header: 'SL thực nhận', key: 'confirmedQuantity', width: 14 },
          { header: 'Hàng tốt', key: 'goodQuantity', width: 12 },
          { header: 'Bục rách', key: 'damagedQuantity', width: 12 },
          { header: 'Cận date', key: 'nearExpiryQuantity', width: 12 },
        ]
      : [
          { header: 'Mã phiếu trả', key: 'code', width: 20 },
          { header: 'Mã phiếu xuất', key: 'internalUseCode', width: 22 },
          { header: 'Chi nhánh', key: 'branch', width: 22 },
          { header: 'Người tạo', key: 'creator', width: 20 },
          { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
          { header: 'SL yêu cầu trả', key: 'totalRequestQuantity', width: 16 },
          { header: 'SL thực nhận', key: 'totalConfirmedQuantity', width: 14 },
          { header: 'Trạng thái', key: 'status', width: 20 },
          { header: 'Ghi chú', key: 'note', width: 32 },
        ];
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.commit();

    const rows = await this.prisma.internalUseReturn.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        internalUse: { select: { code: true } },
        branch: { select: { name: true } },
        creator: { select: { name: true } },
        details: true,
      },
    });
    for (const row of rows) {
      const base = {
        code: row.code,
        internalUseCode: row.internalUse.code,
        branch: row.branch.name,
        creator: row.creator.name,
        createdAt: row.createdAt.toLocaleString('vi-VN'),
        totalRequestQuantity: Number(row.totalRequestQuantity),
        totalConfirmedQuantity: Number(row.totalConfirmedQuantity),
        status:
          INTERNAL_USE_RETURN_STATUS_LABELS[row.status] || 'Không xác định',
        note: row.note || '',
      };
      if (!detailMode) {
        sheet.addRow(base).commit();
      } else {
        for (const detail of row.details) {
          sheet
            .addRow({
              ...base,
              productCode: detail.productCode,
              productName: detail.productName,
              issuedQuantity: Number(detail.issuedQuantity),
              requestQuantity: Number(detail.requestQuantity),
              confirmedQuantity: Number(detail.confirmedQuantity),
              goodQuantity: Number(detail.goodQuantity),
              damagedQuantity: Number(detail.damagedQuantity),
              nearExpiryQuantity: Number(detail.nearExpiryQuantity),
            })
            .commit();
        }
      }
    }
    await workbook.commit();
  }
}
