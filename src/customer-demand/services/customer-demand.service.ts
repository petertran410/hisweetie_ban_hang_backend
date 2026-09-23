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
  UpdateCustomerDemandMonthDto,
  UpdateCustomerDemandDto,
} from '../dto';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

const LEGACY_LARK_DEMAND_NOTE = 'Đồng bộ tự động từ LarkBase';

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
    if (query.customerSearch?.trim()) {
      const matchedIds = await this.repository.searchCustomerIds(
        query.customerSearch,
      );
      if (query.customerId) {
        if (!matchedIds.includes(query.customerId)) where.customerId = -1;
      } else {
        where.customerId = { in: matchedIds.length ? matchedIds : [-1] };
      }
    }
    if (query.month || query.monthFrom || query.monthTo || query.status) {
      where.months = { some: this.monthWhere(query) };
    }
    const [rows, total] = await this.repository.findList(
      where,
      (page - 1) * limit,
      limit,
      this.listOrderBy(query.sortBy, query.sortOrder),
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

  async orderSummary(query: CustomerDemandQueryDto) {
    const where = this.monthWhere({
      ...query,
      status: query.status ?? 'CONFIRMED',
    });
    const customerSearchIds = query.customerSearch?.trim()
      ? await this.repository.searchCustomerIds(query.customerSearch)
      : null;
    if (query.customerId) {
      where.demand = { customerId: query.customerId };
    } else if (customerSearchIds) {
      where.demand = {
        customerId: { in: customerSearchIds.length ? customerSearchIds : [-1] },
      };
    }
    const months = await this.repository.findSummaryMonths(where);
    const search = this.normalizeSearch(query.search);
    const monthKeys = new Set<string>();
    const products = new Map<
      number,
      {
        product: { id: number; code: string; name: string; unit: string | null };
        customers: Set<number>;
        customersByMonth: Map<string, Set<number>>;
        customerDetails: Map<
          number,
          { id: number; code: string | null; name: string }
        >;
        detailsByMonth: Map<
          string,
          Array<{
            demandId: number;
            demandMonthId: number;
            demandMonth: string;
            customer: { id: number; code: string | null; name: string };
            quantityBase: number;
            inputQuantity: number;
            inputUnit: string;
          }>
        >;
        quantities: Map<string, number>;
      }
    >();

    for (const month of months) {
      const monthKey = this.monthKey(month.demandMonth);
      const customerId = month.demand?.customerId;
      for (const line of month.lines ?? []) {
        const product = line.product;
        if (!product) continue;
        const haystack = `${product.code ?? ''} ${product.name ?? ''}`.toLowerCase();
        if (search && !haystack.includes(search)) continue;
        const quantity = Number(line.quantityBase);
        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        monthKeys.add(monthKey);
        let bucket = products.get(product.id);
        if (!bucket) {
          bucket = {
            product: {
              id: product.id,
              code: product.code,
              name: product.name,
              unit: product.unit ?? null,
            },
            customers: new Set<number>(),
            customersByMonth: new Map<string, Set<number>>(),
            customerDetails: new Map<
              number,
              { id: number; code: string | null; name: string }
            >(),
            detailsByMonth: new Map(),
            quantities: new Map<string, number>(),
          };
          products.set(product.id, bucket);
        }
        if (customerId) {
          bucket.customers.add(customerId);
          if (month.demand?.customer) {
            bucket.customerDetails.set(customerId, month.demand.customer);
          }
          const monthCustomers =
            bucket.customersByMonth.get(monthKey) ?? new Set<number>();
          monthCustomers.add(customerId);
          bucket.customersByMonth.set(monthKey, monthCustomers);
          const details = bucket.detailsByMonth.get(monthKey) ?? [];
          details.push({
            demandId: month.demandId,
            demandMonthId: month.id,
            demandMonth: monthKey,
            customer: month.demand.customer,
            quantityBase: quantity,
            inputQuantity: Number(line.inputQuantity),
            inputUnit: line.inputUnit,
          });
          bucket.detailsByMonth.set(monthKey, details);
        }
        bucket.quantities.set(
          monthKey,
          this.roundQuantity((bucket.quantities.get(monthKey) ?? 0) + quantity),
        );
      }
    }

    const orderedMonths = [...monthKeys].sort();
    const rows = [...products.values()]
      .map((bucket) => {
        const quantities = Object.fromEntries(
          orderedMonths.map((month) => [
            month,
            this.roundQuantity(bucket.quantities.get(month) ?? 0),
          ]),
        );
        return {
          product: bucket.product,
          customerCount: bucket.customers.size,
          totalQuantityBase: this.roundQuantity(
            [...bucket.quantities.values()].reduce((sum, value) => sum + value, 0),
          ),
          quantities,
          customersByMonth: Object.fromEntries(
            [...bucket.customersByMonth.entries()].map(([month, customers]) => [
              month,
              [...customers].map((customerId) =>
                bucket.customerDetails.get(customerId),
              ).filter(Boolean),
            ]),
          ),
          customers: [...bucket.customerDetails.values()],
          detailsByMonth: Object.fromEntries(bucket.detailsByMonth),
        };
      })
      .sort((left, right) =>
        left.product.code.localeCompare(right.product.code, 'vi'),
      );
    const totals = Object.fromEntries(
      orderedMonths.map((month) => [
        month,
        this.roundQuantity(
          rows.reduce((sum, row) => sum + (row.quantities[month] ?? 0), 0),
        ),
      ]),
    );

    return {
      months: orderedMonths,
      products: rows,
      totals,
      totalQuantityBase: this.roundQuantity(
        rows.reduce((sum, row) => sum + row.totalQuantityBase, 0),
      ),
    };
  }

  async exportSummary(query: CustomerDemandQueryDto, res: Response) {
    const summary = await this.orderSummary(query);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Tong quan Demand');
    const monthColumns = summary.months.map((month) => ({
      header: month,
      key: month,
      width: 14,
    }));

    sheet.columns = [
      { header: 'STT', key: 'index', width: 8 },
      { header: 'Mã hàng', key: 'code', width: 20 },
      { header: 'Tên hàng', key: 'name', width: 38 },
      { header: 'Đơn vị cơ bản', key: 'unit', width: 16 },
      { header: 'Số khách', key: 'customerCount', width: 12 },
      ...monthColumns,
      { header: 'Tổng quy đổi', key: 'total', width: 16 },
    ];
    summary.products.forEach((row, index) => {
      const values: Record<string, unknown> = {
        index: index + 1,
        code: row.product.code,
        name: row.product.name,
        unit: row.product.unit ?? 'Đơn vị',
        customerCount: row.customerCount,
        total: row.totalQuantityBase,
      };
      for (const month of summary.months) {
        values[month] = row.quantities[month] ?? 0;
      }
      sheet.addRow(values);
    });
    const totalValues: Record<string, unknown> = {
      index: '',
      code: '',
      name: 'TỔNG',
      unit: '',
      customerCount: '',
      total: summary.totalQuantityBase,
    };
    for (const month of summary.months) {
      totalValues[month] = summary.totals[month] ?? 0;
    }
    sheet.addRow(totalValues);
    this.styleExportSheet(sheet);
    return this.sendExcel(res, workbook, `demand-khach-hang-tong-quan-${Date.now()}.xlsx`);
  }

  async exportDetail(query: CustomerDemandQueryDto, res: Response) {
    const where = this.monthWhere({
      ...query,
      status: query.status ?? 'CONFIRMED',
    });
    const customerSearchIds = query.customerSearch?.trim()
      ? await this.repository.searchCustomerIds(query.customerSearch)
      : null;
    if (query.customerId) {
      where.demand = { customerId: query.customerId };
    } else if (customerSearchIds) {
      where.demand = {
        customerId: { in: customerSearchIds.length ? customerSearchIds : [-1] },
      };
    }
    const months = await this.repository.findExportMonths(where);
    const search = this.normalizeSearch(query.search);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Chi tiet Demand');
    sheet.columns = [
      { header: 'STT', key: 'index', width: 8 },
      { header: 'Mã phiếu', key: 'demandId', width: 12 },
      { header: 'Khách hàng', key: 'customer', width: 36 },
      { header: 'Mã khách', key: 'customerCode', width: 18 },
      { header: 'Tháng', key: 'month', width: 12 },
      { header: 'Trạng thái', key: 'status', width: 16 },
      { header: 'Mã hàng', key: 'productCode', width: 20 },
      { header: 'Tên hàng', key: 'productName', width: 38 },
      { header: 'Đơn vị nhập', key: 'inputUnit', width: 16 },
      { header: 'Số lượng nhập', key: 'inputQuantity', width: 16 },
      { header: 'Đơn vị cơ bản', key: 'baseUnit', width: 16 },
      { header: 'Số lượng quy đổi', key: 'quantityBase', width: 18 },
      { header: 'Ghi chú', key: 'note', width: 36 },
    ];

    let index = 0;
    for (const month of months) {
      for (const line of month.lines) {
        const haystack =
          `${line.product.code} ${line.product.name}`.toLocaleLowerCase('vi');
        if (search && !haystack.includes(search)) continue;
        index += 1;
        sheet.addRow({
          index,
          demandId: `#${month.demandId}`,
          customer: month.demand.customer.name,
          customerCode: month.demand.customer.code ?? '',
          month: this.monthKey(month.demandMonth),
          status: this.statusLabel(month.status),
          productCode: line.product.code,
          productName: line.product.name,
          inputUnit:
            line.inputUnit === 'CARTON'
              ? 'Thùng'
              : line.product.unit ?? 'Đơn vị',
          inputQuantity: Number(line.inputQuantity),
          baseUnit: line.product.unit ?? 'Đơn vị',
          quantityBase: Number(line.quantityBase),
          note: month.note ?? month.demand.note ?? '',
        });
      }
    }
    this.styleExportSheet(sheet);
    return this.sendExcel(res, workbook, `demand-khach-hang-chi-tiet-${Date.now()}.xlsx`);
  }

  async get(id: number) {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundException('Không tìm thấy phiếu Demand');
    return this.mapDetail(row);
  }

  async create(dto: CreateCustomerDemandDto, userId: number) {
    if (dto.months.length !== 1) {
      throw new BadRequestException(
        'Mỗi phiếu Demand chỉ được tạo cho một tháng',
      );
    }
    const customer = await this.repository.findCustomer(dto.customerId);
    if (!customer) throw new BadRequestException('Khách hàng không tồn tại');
    const months = await this.normalizeMonths(dto.months);
    const id = await this.repository.createConfirmed({
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
          'Không thể xóa tháng đã hoàn thành hoặc đã hủy khỏi phiếu',
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

  async updateMonth(
    id: number,
    dto: UpdateCustomerDemandMonthDto,
    userId: number,
  ) {
    const current: any = await this.repository.findMonthById(id);
    if (!current) throw new NotFoundException('Không tìm thấy tháng Demand');
    if (current.status === 'CANCELLED') {
      throw new BadRequestException('Không được sửa tháng đã hủy');
    }
    if (
      dto.customerId !== undefined &&
      dto.customerId !== current.demand.customerId
    ) {
      const customer = await this.repository.findCustomer(dto.customerId);
      if (!customer) throw new BadRequestException('Khách hàng không tồn tại');
    }

    const nextMonth = dto.month ?? this.monthKey(current.demandMonth);
    const normalizedLines = await this.normalizeLines(dto.lines);
    const lineIds = dto.lines.map((line) => line.id).filter((id): id is number => id != null);
    if (
      new Set(lineIds).size !== lineIds.length ||
      lineIds.some((lineId) => !current.lines.some((line: any) => line.id === lineId))
    ) {
      throw new BadRequestException('Dòng Demand không thuộc tháng này hoặc bị trùng');
    }
    const incoming: CustomerDemandMonthDto = {
      id,
      month: nextMonth,
      lines: dto.lines,
      changeNote: dto.changeNote,
    };
    const confirmedChange =
      current.status === 'CONFIRMED' &&
      this.changed(current, incoming, normalizedLines)
        ? {
            reason: this.requireChangeNote(dto.changeNote),
            before: this.snapshotMonth(current),
          }
        : undefined;

    await this.repository.updateMonth(id, {
      customerId: dto.customerId,
      demandMonth: this.monthDate(nextMonth),
      lines: normalizedLines.map((line, index) => ({
        ...line,
        ...(dto.lines[index].id ? { id: dto.lines[index].id } : {}),
      })),
      note: dto.note,
      updatedBy: userId,
      confirmedChange,
    });
    return this.get(current.demandId);
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
    }

    const currentMonths = new Map<number, any>(
      (current?.months ?? []).map((month: any) => [month.id, month]),
    );
    return Promise.all(
      months.map(async (month) => {
        const existing = month.id ? currentMonths.get(month.id) : null;
        if (existing?.status === 'CANCELLED')
          throw new BadRequestException('Không được sửa tháng đã hủy');
        const normalizedLines = await this.normalizeLines(month.lines);
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
      }),
    );
  }

  private async normalizeLines(lines: CustomerDemandLineDto[]) {
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const products = await this.repository.findProducts(productIds);
    const productMap = new Map(
      products.map((product: any) => [product.id, product]),
    );
    for (const id of productIds) {
      if (!productMap.has(id))
        throw new BadRequestException(`Sản phẩm ${id} không tồn tại`);
    }
    return lines.map((line) =>
      this.normalizeLine(line, productMap.get(line.productId)),
    );
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
      .sort(this.compareLines);
    const next = lines
      .map((line) => ({
        productId: line.productId,
        inputQuantity: line.inputQuantity,
        inputUnit: line.inputUnit,
        quantityBase: line.quantityBase,
      }))
      .sort(this.compareLines);
    return JSON.stringify(previous) !== JSON.stringify(next);
  }

  private compareLines(
    left: {
      productId: number;
      inputQuantity: number;
      inputUnit: string;
      quantityBase: number;
    },
    right: {
      productId: number;
      inputQuantity: number;
      inputUnit: string;
      quantityBase: number;
    },
  ) {
    return (
      left.productId - right.productId ||
      left.inputUnit.localeCompare(right.inputUnit) ||
      left.inputQuantity - right.inputQuantity ||
      left.quantityBase - right.quantityBase
    );
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
        'Phải nhập lý do khi sửa Demand đã hoàn thành',
      );
    return value.trim();
  }

  private monthWhere(query: CustomerDemandQueryDto) {
    const where: Record<string, any> = {};
    const demandMonth: Record<string, Date> = {};
    if (query.status) where.status = query.status;
    if (query.month) {
      const date = this.monthDate(query.month);
      const next = new Date(date);
      next.setUTCMonth(next.getUTCMonth() + 1);
      demandMonth.gte = date;
      demandMonth.lt = next;
    } else if (query.monthFrom || query.monthTo) {
      if (query.monthFrom) demandMonth.gte = this.monthDate(query.monthFrom);
      if (query.monthTo) {
        const next = this.monthDate(query.monthTo);
        next.setUTCMonth(next.getUTCMonth() + 1);
        demandMonth.lt = next;
      }
    }
    if (Object.keys(demandMonth).length) where.demandMonth = demandMonth;
    return where;
  }

  private monthDate(value: string) {
    return new Date(`${value}-01T00:00:00.000Z`);
  }

  private normalizeSearch(value?: string) {
    return value?.trim().toLocaleLowerCase('vi') ?? '';
  }

  private roundQuantity(value: number) {
    return Math.round((value + Number.EPSILON) * 10000) / 10000;
  }

  private monthKey(value: Date | string) {
    return new Date(value).toISOString().slice(0, 7);
  }

  private statusLabel(status: string) {
    if (status === 'CONFIRMED') return 'Hoàn thành';
    if (status === 'CANCELLED') return 'Đã hủy';
    return 'Chưa cập nhật';
  }

  private styleExportSheet(sheet: ExcelJS.Worksheet) {
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0F766E' },
    };
    header.alignment = { vertical: 'middle', horizontal: 'center' };
    header.height = 24;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = {
      from: 'A1',
      to: `${this.excelColumnName(sheet.columnCount)}1`,
    };
  }

  private excelColumnName(columnNumber: number) {
    let value = columnNumber;
    let result = '';
    while (value > 0) {
      const remainder = (value - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      value = Math.floor((value - 1) / 26);
    }
    return result;
  }

  private async sendExcel(
    res: Response,
    workbook: ExcelJS.Workbook,
    filename: string,
  ) {
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await workbook.xlsx.write(res);
    res.end();
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
      sourceSystem: row.sourceSystem,
      hasSourceDates: months.some((month: any) =>
        (month.lines ?? []).some((line: any) => !!line.sourceCreatedAt),
      ),
      note: row.note === LEGACY_LARK_DEMAND_NOTE ? null : row.note,
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

  private listOrderBy(
    sortBy: CustomerDemandQueryDto['sortBy'] = 'createdAt',
    sortOrder: CustomerDemandQueryDto['sortOrder'] = 'desc',
  ) {
    const direction = sortOrder === 'asc' ? 'asc' : 'desc';
    const idDirection = direction;

    switch (sortBy) {
      case 'updatedAt':
        return [{ updatedAt: direction }, { id: idDirection }];
      case 'id':
        return [{ id: direction }];
      case 'customerName':
        return [{ customer: { name: direction } }, { id: 'desc' }];
      case 'createdAt':
      default:
        return [{ createdAt: direction }, { id: idDirection }];
    }
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
          sourceCreatedAt: line.sourceCreatedAt,
          sourceUpdatedAt: line.sourceUpdatedAt,
        })),
        changeLogs: month.changeLogs ?? [],
      })),
    };
  }
}
