import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SepayTransactionQueryDto } from './dto/sepay-transaction-query.dto';
import { SepayMatchService } from './sepay-match.service';

/**
 * Một giao dịch trả về từ Sepay List API.
 * GET https://my.sepay.vn/userapi/transactions/list
 */
interface SepayApiTransaction {
  id: string;
  bank_brand_name?: string | null;
  account_number?: string | null;
  transaction_date?: string | null;
  amount_out?: string | null;
  amount_in?: string | null;
  accumulated?: string | null;
  transaction_content?: string | null;
  reference_number?: string | null;
  code?: string | null;
  sub_account?: string | null;
  bank_account_id?: string | null;
}

interface SepayListResponse {
  status: number;
  error: string | null;
  messages?: { success: boolean };
  transactions?: SepayApiTransaction[];
}

export interface SepaySyncResult {
  fetched: number;
  created: number;
  updated: number;
  pages: number;
}

@Injectable()
export class SepaySyncService {
  private readonly logger = new Logger(SepaySyncService.name);
  private readonly baseUrl: string;
  private readonly accessToken: string;
  // List API tối đa 5000 giao dịch / lần.
  private readonly PAGE_LIMIT = 5000;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly matchService: SepayMatchService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'SEPAY_API_URL',
      'https://my.sepay.vn/userapi',
    );
    this.accessToken =
      this.configService.get<string>('SEPAY_ACCESS_TOKEN') || '';
  }

  /**
   * Đồng bộ toàn bộ lịch sử giao dịch Sepay vào bảng SepayTransaction.
   *
   * Phân trang lùi theo thời gian: List API trả tối đa 5000 giao dịch mới nhất
   * (id/thời gian giảm dần). Để lấy hết khi có >5000 giao dịch, ta dùng tham số
   * transaction_date_max = thời gian giao dịch CŨ NHẤT của trang trước (<=),
   * cuốn chiếu lùi về quá khứ cho tới khi trang không còn đầy.
   *
   * Idempotent: dùng upsert theo sepayId nên chạy lại nhiều lần KHÔNG tạo trùng,
   * và KHÔNG đụng tới phiếu thu / đơn / hóa đơn / sổ quỹ.
   */
  async syncAll(): Promise<SepaySyncResult> {
    if (!this.accessToken) {
      throw new Error('SEPAY_ACCESS_TOKEN chưa được cấu hình');
    }

    const result: SepaySyncResult = {
      fetched: 0,
      created: 0,
      updated: 0,
      pages: 0,
    };

    // Boundary thời gian cho trang kế (Sepay format "yyyy-mm-dd HH:MM:SS", giờ VN).
    let transactionDateMax: string | undefined = undefined;
    // Theo dõi id đã xử lý trong lần chạy này để phát hiện "không tiến triển".
    const seenIds = new Set<string>();
    // Chặn vòng lặp vô hạn nếu API trả lỗi/loop bất thường.
    const MAX_PAGES = 1000;

    while (result.pages < MAX_PAGES) {
      const transactions = await this.fetchPage(transactionDateMax);
      result.pages += 1;

      if (!transactions.length) break;

      // Lọc các giao dịch mới (chưa thấy trong lần chạy này) để phát hiện loop.
      const freshTxs = transactions.filter((tx) => !seenIds.has(String(tx.id)));

      result.fetched += freshTxs.length;

      let oldestDate: string | undefined = undefined;
      for (const tx of freshTxs) {
        seenIds.add(String(tx.id));
        if (
          tx.transaction_date &&
          (oldestDate === undefined || tx.transaction_date < oldestDate)
        ) {
          oldestDate = tx.transaction_date;
        }
        const { isCreated } = await this.upsertTransaction(tx);
        if (isCreated) result.created += 1;
        else result.updated += 1;
      }

      this.logger.log(
        `Sepay sync: page ${result.pages}, +${freshTxs.length} new tx ` +
          `(fetched=${result.fetched}, created=${result.created}, updated=${result.updated})`,
      );

      // Trang chưa đầy => đã chạm giao dịch cũ nhất => dừng.
      if (transactions.length < this.PAGE_LIMIT) break;

      // Không còn giao dịch mới hoặc không lấy được mốc thời gian => dừng để
      // tránh lặp vô hạn (vd. cả trang cùng một timestamp).
      if (freshTxs.length === 0 || !oldestDate) break;

      transactionDateMax = oldestDate;
    }

    this.logger.log(`Sepay sync done: ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * Lấy 1 trang giao dịch. transactionDateMax (nếu có) giới hạn các giao dịch
   * có transaction_date <= mốc này, dùng để cuốn chiếu lùi về quá khứ.
   */
  private async fetchPage(
    transactionDateMax?: string,
  ): Promise<SepayApiTransaction[]> {
    const params: Record<string, string> = {
      limit: String(this.PAGE_LIMIT),
    };
    if (transactionDateMax) {
      params.transaction_date_max = transactionDateMax;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<SepayListResponse>(
          `${this.baseUrl}/transactions/list`,
          {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json',
            },
            params,
            timeout: 120000,
          },
        ),
      );

      return response.data?.transactions ?? [];
    } catch (error: any) {
      const status = error.response?.status;
      const data = error.response?.data;
      this.logger.error(
        `Sepay list API error: status=${status}, message=${error.message}, ` +
          `data=${JSON.stringify(data)}`,
      );
      throw error;
    }
  }

  private parseDecimal(value?: string | null): Prisma.Decimal | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    try {
      return new Prisma.Decimal(value);
    } catch {
      return undefined;
    }
  }

  private parseDate(value?: string | null): Date | undefined {
    if (!value) return undefined;
    // Sepay trả "yyyy-mm-dd HH:MM:SS" giờ Việt Nam (UTC+7).
    const normalized = value.replace(' ', 'T') + '+07:00';
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? undefined : d;
  }

  private async upsertTransaction(
    tx: SepayApiTransaction,
  ): Promise<{ isCreated: boolean }> {
    const sepayId = String(tx.id);

    const data = {
      transactionDate: this.parseDate(tx.transaction_date),
      accountNumber: tx.account_number ?? undefined,
      subAccount: tx.sub_account ?? undefined,
      amountIn: this.parseDecimal(tx.amount_in) ?? new Prisma.Decimal(0),
      amountOut: this.parseDecimal(tx.amount_out) ?? new Prisma.Decimal(0),
      accumulated: this.parseDecimal(tx.accumulated),
      code: tx.code ?? undefined,
      transactionContent: tx.transaction_content ?? undefined,
      referenceNumber: tx.reference_number ?? undefined,
      bankBrandName: tx.bank_brand_name ?? undefined,
      bankAccountId: tx.bank_account_id ?? undefined,
      rawPayload: tx as unknown as Prisma.InputJsonValue,
      syncedAt: new Date(),
    };

    const existing = await this.prisma.sepayTransaction.findUnique({
      where: { sepayId },
      select: { id: true },
    });

    await this.prisma.sepayTransaction.upsert({
      where: { sepayId },
      create: { sepayId, ...data },
      update: data,
    });

    return { isCreated: !existing };
  }

  /**
   * Mệnh đề match 1 tài khoản, có xử lý VA (virtual account).
   * BIDV: bank_accounts lưu VA (vd 96460248888) nhưng Sepay report
   * accountNumber = TK chính (vd 8601539888) còn subAccount = VA.
   * Khách luôn chuyển vào VA → mọi giao dịch của VA đều mang subAccount = VA.
   *   - giao dịch qua VA: subAccount = TK đã chọn
   *   - giao dịch TK thường (không VA): accountNumber = TK đã chọn VÀ subAccount rỗng
   */
  private buildAccountMatchClause(
    accountNumber: string,
  ): Prisma.SepayTransactionWhereInput {
    return {
      OR: [
        { subAccount: accountNumber },
        { accountNumber: accountNumber, subAccount: null },
      ],
    };
  }

  /**
   * Quyết định ràng buộc tài khoản cho user hiện tại theo Settings.
   * Trả về:
   *   - undefined : không lọc (cờ tắt)
   *   - 'BYPASS'  : cờ bật nhưng user là Admin/Super Admin → xem hết
   *   - 'NONE'    : cờ bật, user thường nhưng CHƯA gán TK → không thấy gì
   *   - string    : số tài khoản user được phép xem
   */
  private async resolveAccountRestriction(
    currentUser?: any,
  ): Promise<string | 'BYPASS' | 'NONE' | undefined> {
    if (!currentUser) return undefined;

    const settings = await this.prisma.settings.findFirst({
      select: { sepayFilterByAccount: true },
    });
    if (!settings?.sepayFilterByAccount) return undefined;

    const roles: string[] = currentUser.roles || [];
    if (roles.includes('Super Admin') || roles.includes('Admin')) {
      return 'BYPASS';
    }

    // Kế toán: có quyền sepay:view_all → xem toàn bộ giao dịch (bỏ qua lọc TK).
    const permissions: string[] = currentUser.permissions || [];
    if (permissions.includes('sepay:view_all')) {
      return 'BYPASS';
    }

    const acc = currentUser.bankAccountNumber;
    if (!acc) return 'NONE';
    return acc;
  }

  /**
   * Danh sách giao dịch Sepay đã đồng bộ (đọc bảng sepay_transactions).
   * Có filter + phân trang. Chỉ đọc, không gọi Sepay API.
   */
  async findAll(query: SepayTransactionQueryDto, currentUser?: any) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.SepayTransactionWhereInput = {};
    const andClauses: Prisma.SepayTransactionWhereInput[] = [];

    if (query.search) {
      where.OR = [
        { transactionContent: { contains: query.search, mode: 'insensitive' } },
        { referenceNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.accountNumber) {
      andClauses.push(this.buildAccountMatchClause(query.accountNumber));
    }

    // ── Phân quyền theo tài khoản (Settings.sepayFilterByAccount) ──
    // Khi bật: user thường chỉ thấy record của TK ngân hàng đã gán cho họ.
    // Admin/Super Admin bypass. User chưa gán TK → không thấy gì.
    const restrict = await this.resolveAccountRestriction(currentUser);
    if (restrict === 'NONE') {
      // Cờ bật nhưng user chưa gán TK → trả rỗng
      return { data: [], total: 0, page, limit };
    }
    if (restrict && restrict !== 'BYPASS') {
      andClauses.push(this.buildAccountMatchClause(restrict));
    }

    if (andClauses.length > 0) {
      where.AND = andClauses;
    }

    // in = có tiền vào (amountIn > 0); out = có tiền ra (amountOut > 0)
    if (query.transferType === 'in') {
      where.amountIn = { gt: 0 };
    } else if (query.transferType === 'out') {
      where.amountOut = { gt: 0 };
    }

    if (query.dateFrom || query.dateTo) {
      const dateFilter: Prisma.DateTimeFilter = {};
      if (query.dateFrom) {
        const from = this.parseFilterDate(query.dateFrom, false);
        if (from) dateFilter.gte = from;
      }
      if (query.dateTo) {
        const to = this.parseFilterDate(query.dateTo, true);
        if (to) dateFilter.lte = to;
      }
      if (dateFilter.gte || dateFilter.lte) {
        where.transactionDate = dateFilter;
      }
    }

    // Khi KHÔNG lọc theo status: query Prisma thuần (tận dụng index, nhanh).
    if (!query.status) {
      const [data, total] = await Promise.all([
        this.prisma.sepayTransaction.findMany({
          where,
          orderBy: { transactionDate: 'desc' },
          skip,
          take: limit,
        }),
        this.prisma.sepayTransaction.count({ where }),
      ]);
      const withMatch = await this.attachMatch(data);
      return { data: withMatch, total, page, limit };
    }

    // Khi LỌC theo status (cross-table, suy ra on-read): lấy toàn bộ id theo
    // các filter cơ bản, gắn match info, lọc theo status ở memory rồi phân trang.
    // Số giao dịch chưa hoàn thành (processing/assigned) luôn nhỏ; với
    // "completed" thì vẫn chính xác, chỉ tốn hơn chút.
    const allIds = await this.prisma.sepayTransaction.findMany({
      where,
      orderBy: { transactionDate: 'desc' },
      select: {
        id: true,
        sepayId: true,
        assignedCustomerId: true,
        assignedCustomerName: true,
        cashFlowId: true,
      },
    });

    const matchMap = await this.matchService.buildMatchInfo(allIds);
    const filteredIds = allIds.filter(
      (t) => matchMap.get(t.sepayId)?.status === query.status,
    );

    const total = filteredIds.length;
    const pageIds = filteredIds.slice(skip, skip + limit).map((t) => t.id);

    const rows = await this.prisma.sepayTransaction.findMany({
      where: { id: { in: pageIds } },
    });
    // Giữ đúng thứ tự đã sort
    const orderIndex = new Map(pageIds.map((id, i) => [id, i]));
    rows.sort((a, b) => (orderIndex.get(a.id)! - orderIndex.get(b.id)!));

    const withMatch = await this.attachMatch(rows);
    return { data: withMatch, total, page, limit };
  }

  /** Gắn thông tin đối soát (match) vào từng giao dịch. */
  private async attachMatch<
    T extends {
      sepayId: string;
      assignedCustomerId: number | null;
      assignedCustomerName: string | null;
      cashFlowId: number | null;
    },
  >(rows: T[]) {
    const matchMap = await this.matchService.buildMatchInfo(rows);
    return rows.map((r) => ({
      ...r,
      match: matchMap.get(r.sepayId) ?? null,
    }));
  }

  /**
   * Parse ngày filter. endOfDay=true sẽ đẩy về cuối ngày (giờ VN) khi input
   * chỉ là yyyy-mm-dd, để bao trọn cả ngày khi lọc <=.
   */
  private parseFilterDate(value: string, endOfDay: boolean): Date | undefined {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const iso = dateOnly
      ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+07:00`
      : value;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? undefined : d;
  }
}
