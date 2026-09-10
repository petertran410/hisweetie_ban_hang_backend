import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { CustomerDemandRepository } from '../repositories/customer-demand.repository';
import {
  CustomerDemandLineDto,
  CustomerDemandMonthActionDto,
  CustomerDemandMonthDto,
  CustomerDemandQueryDto,
  CreateCustomerDemandDto,
  UpdateCustomerDemandDto,
} from '../dto';

@Injectable()
export class CustomerDemandService {
  constructor(
    private readonly repository: CustomerDemandRepository,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async list(query: CustomerDemandQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);
    const where: Record<string, any> = {};
    if (query.customerId) where.customerId = query.customerId;
    if (query.month || query.status) {
      where.months = { some: this.monthWhere(query) };
    }
    const [rows, total] = await this.repository.findList(
      where,
      (page - 1) * limit,
      limit,
    );
    return {
      data: rows.map((row: any) => this.mapList(row)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async searchCustomers(search?: string) {
    return this.repository.searchCustomers(search);
  }

  async get(id: number) {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundException('Không tìm thấy phiếu Demand');
    return this.mapDetail(row);
  }

  async create(dto: CreateCustomerDemandDto, userId: number) {
    const customer = await this.repository.findCustomer(dto.customerId);
    if (!customer) throw new BadRequestException('Khách hàng không tồn tại');
    const months = await this.normalizeMonths(dto.months);
    const id = await this.repository.createDraft({
      customerId: dto.customerId,
      note: dto.note ?? null,
      createdBy: userId,
      months,
    });
    await this.auditLogs.create({
      actionType: 'CREATE',
      actionCode: 'CUSTOMER_DEMAND_CREATE',
      entityType: 'CUSTOMER_DEMAND',
      entityId: String(id),
      message: `Đã tạo phiếu Demand khách hàng #${id}`,
      userId,
      userName: 'System',
      snapshot: { customerId: dto.customerId, months },
    });
    return this.get(id);
  }

  async update(id: number, dto: UpdateCustomerDemandDto, userId: number) {
    const current: any = await this.repository.findById(id);
    if (!current) throw new NotFoundException('Không tìm thấy phiếu Demand');
    if (dto.customerId !== undefined) {
      const customer = await this.repository.findCustomer(dto.customerId);
      if (!customer) throw new BadRequestException('Khách hàng không tồn tại');
    }
    const incomingIds = new Set(
      dto.months.map((month) => month.id).filter((value): value is number => !!value),
    );
    for (const existing of current.months ?? []) {
      if (incomingIds.has(existing.id)) continue;
      if (existing.status !== 'DRAFT') {
        throw new BadRequestException(
          'Không thể xóa tháng đã xác nhận hoặc đã hủy khỏi phiếu',
        );
      }
    }
    const months = await this.normalizeMonths(dto.months, current);
    await this.repository.updateDemand(id, {
      customerId: dto.customerId,
      note: dto.note,
      updatedBy: userId,
      months,
    });
    return this.get(id);
  }

  async approveMonth(id: number, userId: number) {
    const month: any = await this.repository.findMonthById(id);
    if (!month) throw new NotFoundException('Không tìm thấy tháng Demand');
    if (month.status !== 'DRAFT')
      throw new BadRequestException('Chỉ được duyệt tháng Draft');
    const updated = await this.repository.approveMonth(id, userId);
    return { id: updated.id, status: updated.status };
  }

  async cancelMonth(
    id: number,
    dto: CustomerDemandMonthActionDto,
    userId: number,
  ) {
    const month: any = await this.repository.findMonthById(id);
    if (!month) throw new NotFoundException('Không tìm thấy tháng Demand');
    if (month.status === 'CANCELLED')
      throw new BadRequestException('Tháng Demand đã hủy');
    const updated = await this.repository.cancelMonth(id, userId, dto.reason);
    return { id: updated.id, status: updated.status };
  }

  async planningMonths() {
    return this.repository.findPlanningMonths();
  }

  private async normalizeMonths(
    months: CustomerDemandMonthDto[],
    current?: any,
  ) {
    const monthKeys = new Set<string>();
    for (const month of months) {
      if (monthKeys.has(month.month))
        throw new BadRequestException(`Trùng tháng ${month.month}`);
      monthKeys.add(month.month);
      const productIds = month.lines.map((line) => line.productId);
      if (new Set(productIds).size !== productIds.length) {
        throw new BadRequestException(
          `Trùng sản phẩm trong tháng ${month.month}`,
        );
      }
    }

    const productIds = [
      ...new Set(
        months.flatMap((month) => month.lines.map((line) => line.productId)),
      ),
    ];
    const products = await this.repository.findProducts(productIds);
    const productMap = new Map(
      products.map((product: any) => [product.id, product]),
    );
    for (const id of productIds) {
      if (!productMap.has(id))
        throw new BadRequestException(`Sản phẩm ${id} không tồn tại`);
    }

    const currentMonths = new Map<number, any>(
      (current?.months ?? []).map((month: any) => [month.id, month]),
    );
    return months.map((month) => {
      const existing = month.id ? currentMonths.get(month.id) : null;
      if (existing?.status === 'CANCELLED')
        throw new BadRequestException('Không được sửa tháng đã hủy');
      const normalizedLines = month.lines.map((line) =>
        this.normalizeLine(line, productMap.get(line.productId)),
      );
      const confirmedChange =
        existing?.status === 'CONFIRMED' &&
        this.changed(existing, month, normalizedLines)
          ? {
              reason: this.requireChangeNote(month.changeNote),
              before: this.snapshotMonth(existing),
            }
          : undefined;
      return {
        id: month.id,
        demandMonth: this.monthDate(month.month),
        lines: normalizedLines,
        confirmedChange,
      };
    });
  }

  private normalizeLine(line: CustomerDemandLineDto, product: any) {
    const inputQuantity = Number(line.quantity);
    if (!Number.isFinite(inputQuantity) || inputQuantity <= 0) {
      throw new BadRequestException(
        `Số lượng sản phẩm ${product?.name ?? line.productId} phải lớn hơn 0`,
      );
    }
    const conversionValue =
      line.unit === 'CARTON' ? Number(product.conversionValue) : 1;
    if (
      line.unit === 'CARTON' &&
      (!Number.isFinite(conversionValue) || conversionValue <= 0)
    ) {
      throw new BadRequestException(
        `Sản phẩm ${product.name} thiếu quy đổi thùng`,
      );
    }
    return {
      productId: line.productId,
      inputQuantity,
      inputUnit: line.unit,
      quantityBase: inputQuantity * conversionValue,
      conversionValue,
    };
  }

  private changed(
    existing: any,
    incoming: CustomerDemandMonthDto,
    lines: any[],
  ) {
    if (this.monthKey(existing.demandMonth) !== incoming.month) return true;
    const previous = (existing.lines ?? [])
      .map((line: any) => ({
        productId: line.productId,
        inputQuantity: Number(line.inputQuantity),
        inputUnit: line.inputUnit,
        quantityBase: Number(line.quantityBase),
      }))
      .sort((a: any, b: any) => a.productId - b.productId);
    const next = lines
      .map((line) => ({
        productId: line.productId,
        inputQuantity: line.inputQuantity,
        inputUnit: line.inputUnit,
        quantityBase: line.quantityBase,
      }))
      .sort((a: any, b: any) => a.productId - b.productId);
    return JSON.stringify(previous) !== JSON.stringify(next);
  }

  private snapshotMonth(month: any) {
    return {
      id: month.id,
      month: this.monthKey(month.demandMonth),
      status: month.status,
      lines: (month.lines ?? []).map((line: any) => ({
        productId: line.productId,
        inputQuantity: Number(line.inputQuantity),
        inputUnit: line.inputUnit,
        quantityBase: Number(line.quantityBase),
      })),
    };
  }

  private requireChangeNote(value?: string) {
    if (!value?.trim())
      throw new BadRequestException(
        'Phải nhập lý do khi sửa tháng đã Confirmed',
      );
    return value.trim();
  }

  private monthWhere(query: CustomerDemandQueryDto) {
    const where: Record<string, any> = {};
    if (query.status) where.status = query.status;
    if (query.month) {
      const date = this.monthDate(query.month);
      const next = new Date(date);
      next.setUTCMonth(next.getUTCMonth() + 1);
      where.demandMonth = { gte: date, lt: next };
    }
    return where;
  }

  private monthDate(value: string) {
    return new Date(`${value}-01T00:00:00.000Z`);
  }

  private monthKey(value: Date | string) {
    return new Date(value).toISOString().slice(0, 7);
  }

  private mapList(row: any) {
    const months = row.months ?? [];
    const totals = new Map<number, number>();
    for (const month of months) {
      for (const line of month.lines ?? []) {
        totals.set(
          line.productId,
          (totals.get(line.productId) ?? 0) + Number(line.quantityBase),
        );
      }
    }
    return {
      id: row.id,
      customer: row.customer,
      note: row.note,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      totalProducts: totals.size,
      totalQuantityBase: [...totals.values()].reduce(
        (sum, value) => sum + value,
        0,
      ),
      months: months.map((month: any) => ({
        id: month.id,
        month: this.monthKey(month.demandMonth),
        status: month.status,
        quantityBase: (month.lines ?? []).reduce(
          (sum: number, line: any) => sum + Number(line.quantityBase),
          0,
        ),
        productCount: month.lines?.length ?? 0,
      })),
    };
  }

  private mapDetail(row: any) {
    return {
      ...this.mapList(row),
      months: (row.months ?? []).map((month: any) => ({
        id: month.id,
        month: this.monthKey(month.demandMonth),
        status: month.status,
        note: month.note,
        approvedAt: month.approvedAt,
        cancelledAt: month.cancelledAt,
        lines: (month.lines ?? []).map((line: any) => ({
          id: line.id,
          productId: line.productId,
          product: line.product,
          inputQuantity: Number(line.inputQuantity),
          inputUnit: line.inputUnit,
          quantityBase: Number(line.quantityBase),
          conversionValue: Number(line.conversionValue),
        })),
        changeLogs: month.changeLogs ?? [],
      })),
    };
  }
}
