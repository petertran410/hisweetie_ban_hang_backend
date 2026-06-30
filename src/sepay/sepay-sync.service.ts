import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { SepayTransactionQueryDto } from './dto/sepay-transaction-query.dto';
import { SepayMatchService } from './sepay-match.service';
import { isSepaySpecialAccount } from './utils/sepay-special-account';

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
    private readonly authService: AuthService,
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
    branchId?: number,
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
    // Quyền có thể được cấp per-branch (roleBranchPermission) nên phải resolve
    // theo chi nhánh giống PermissionsGuard, không chỉ dựa vào permissions global.
    let permissions: string[] = currentUser.permissions || [];
    if (branchId) {
      try {
        permissions = await this.authService.getPermissionsForBranch(
          currentUser.id,
          branchId,
        );
      } catch {
        // fallback dùng permissions global nếu resolve lỗi
      }
    }
    if (permissions.includes('sepay:view_all')) {
      return 'BYPASS';
    }

    const acc = currentUser.bankAccountNumber;
    if (!acc) return 'NONE';
    return acc;
  }

  /**
   * Tổng hợp giao dịch CẦN XỬ LÝ (status processing) cho thông báo sale:
   *   - tiền vào (amount_in > 0)
   *   - chưa gán khách (assigned_customer_id null)
   *   - chưa tạo phiếu thu (cash_flow_id null)
   *   - KHÔNG khớp webhook (không có invoice/order payment cùng sepay_id còn hiệu lực)
   * Tôn trọng phân quyền theo tài khoản (giống findAll).
   * Trả { count, latestId, latest: { amountIn, accountNumber, bankBrandName } }.
   */
  async getPendingSummary(currentUser?: any, branchId?: number) {
    const empty = {
      count: 0,
      latestId: null as number | null,
      latest: null as {
        amountIn: string;
        accountNumber: string | null;
        bankBrandName: string | null;
        referenceNumber: string | null;
        transactionContent: string | null;
        transactionDate: Date | null;
      } | null,
    };

    const restrict = await this.resolveAccountRestriction(
      currentUser,
      branchId,
    );
    if (restrict === 'NONE') {
      return empty;
    }

    // Điều kiện lọc tài khoản (raw SQL) — chỉ khi không bypass và có ràng buộc.
    const acc = restrict && restrict !== 'BYPASS' ? restrict : undefined;
    const accClause = acc
      ? Prisma.sql`AND (st.sub_account = ${acc} OR (st.account_number = ${acc} AND st.sub_account IS NULL))`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      {
        count: bigint;
        latest_id: number | null;
        amount_in: string | null;
        account_number: string | null;
        bank_brand_name: string | null;
        reference_number: string | null;
        transaction_content: string | null;
        transaction_date: Date | null;
      }[]
    >`
      SELECT
        COUNT(*)::bigint AS count,
        latest.id AS latest_id,
        latest.amount_in AS amount_in,
        latest.account_number AS account_number,
        latest.bank_brand_name AS bank_brand_name,
        latest.reference_number AS reference_number,
        latest.transaction_content AS transaction_content,
        latest.transaction_date AS transaction_date
      FROM sepay_transactions st
      LEFT JOIN LATERAL (
        SELECT s2.id, s2.amount_in, s2.account_number, s2.bank_brand_name,
               s2.reference_number, s2.transaction_content, s2.transaction_date
        FROM sepay_transactions s2
        WHERE s2.amount_in > 0
          AND NOT EXISTS (
            SELECT 1 FROM sepay_allocations sa
            WHERE sa.sepay_transaction_id = s2.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM invoice_payments ip
            WHERE ip.sepay_transaction_id = s2.sepay_id AND ip.status <> 2
          )
          AND NOT EXISTS (
            SELECT 1 FROM order_payments op
            WHERE op.sepay_transaction_id = s2.sepay_id AND op.status <> 2
          )
          ${acc ? Prisma.sql`AND (s2.sub_account = ${acc} OR (s2.account_number = ${acc} AND s2.sub_account IS NULL))` : Prisma.empty}
        ORDER BY s2.id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE st.amount_in > 0
        AND NOT EXISTS (
          SELECT 1 FROM sepay_allocations sa
          WHERE sa.sepay_transaction_id = st.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM invoice_payments ip
          WHERE ip.sepay_transaction_id = st.sepay_id AND ip.status <> 2
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_payments op
          WHERE op.sepay_transaction_id = st.sepay_id AND op.status <> 2
        )
        ${accClause}
      GROUP BY latest.id, latest.amount_in, latest.account_number, latest.bank_brand_name,
               latest.reference_number, latest.transaction_content, latest.transaction_date
    `;

    const row = rows[0];
    if (!row || !row.latest_id) return empty;
    return {
      count: Number(row.count),
      latestId: row.latest_id,
      latest: {
        amountIn: row.amount_in ?? '0',
        accountNumber: row.account_number,
        bankBrandName: row.bank_brand_name,
        referenceNumber: row.reference_number,
        transactionContent: row.transaction_content,
        transactionDate: row.transaction_date,
      },
    };
  }

  /**
   * Danh sách giao dịch Sepay đã đồng bộ (đọc bảng sepay_transactions).
   * Có filter + phân trang. Chỉ đọc, không gọi Sepay API.
   */
  async findAll(
    query: SepayTransactionQueryDto,
    currentUser?: any,
    branchId?: number,
  ) {
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
    const restrict = await this.resolveAccountRestriction(
      currentUser,
      branchId,
    );
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

    // ── Lọc ẩn: mặc định chỉ hiện giao dịch CHƯA ẩn (hiddenAt = null).
    // hidden=true → chỉ giao dịch ĐÃ ẩn (để xem lại / bỏ ẩn).
    where.hiddenAt = query.hidden === 'true' ? { not: null } : null;

    // BẮT BUỘC chỉ hiển thị tiền vào (amountIn > 0). Không bao giờ hiện tiền ra.
    const amountFilter: Prisma.DecimalFilter = { gt: 0 };
    const amountMin = Number(query.amountMin);
    const amountMax = Number(query.amountMax);
    const hasMin = query.amountMin != null && !isNaN(amountMin);
    const hasMax = query.amountMax != null && !isNaN(amountMax);
    // Phòng thủ: nếu min > max (input sai lọt qua), bỏ qua cả hai để không
    // ép ra kết quả rỗng do nhầm. Frontend đã chặn min > max trước khi gửi.
    if (!(hasMin && hasMax && amountMin > amountMax)) {
      if (hasMin) amountFilter.gte = amountMin;
      if (hasMax) amountFilter.lte = amountMax;
    }
    where.amountIn = amountFilter;

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
    rows.sort((a, b) => orderIndex.get(a.id)! - orderIndex.get(b.id)!);

    const withMatch = await this.attachMatch(rows);
    return { data: withMatch, total, page, limit };
  }

  /** Ẩn 1 giao dịch khỏi danh sách (ẩn chung toàn hệ thống). */
  async hideTransaction(id: number, userId?: number) {
    const existing = await this.prisma.sepayTransaction.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new Error('Không tìm thấy giao dịch');
    }
    await this.prisma.sepayTransaction.update({
      where: { id },
      data: { hiddenAt: new Date(), hiddenById: userId ?? null },
    });
    return { success: true };
  }

  /** Bỏ ẩn 1 giao dịch — hiển thị lại trong danh sách. */
  async unhideTransaction(id: number) {
    const existing = await this.prisma.sepayTransaction.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new Error('Không tìm thấy giao dịch');
    }
    await this.prisma.sepayTransaction.update({
      where: { id },
      data: { hiddenAt: null, hiddenById: null },
    });
    return { success: true };
  }

  /** Gắn thông tin đối soát (match) vào từng giao dịch. */
  private async attachMatch<T extends { id: number; sepayId: string }>(
    rows: T[],
  ) {
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

  /**
   * Backfill transactionContent cho các sepay_transactions thuộc TK đặc biệt
   * (env SEPAY_SPECIAL_ACCOUNT_NUMBERS). Lấy lại content gốc từ rawPayload
   * (webhook: payload.content | List API: transaction_content | SMS: body_message)
   * và cập nhật transactionContent.
   *
   * KHÔNG đụng CashFlow.description — phiếu thu đã tạo từ trước giữ nguyên note.
   * Idempotent: chạy lại nhiều lần không tạo thay đổi nếu content đã đúng.
   *
   * Trả { updated, skipped, scanned }.
   */
  async backfillSpecialAccountContent(limit: number, _userId?: number) {
    const special = (process.env.SEPAY_SPECIAL_ACCOUNT_NUMBERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (special.length === 0) {
      return { updated: 0, skipped: 0, scanned: 0, message: 'SEPAY_SPECIAL_ACCOUNT_NUMBERS rỗng' };
    }

    const targets = await this.prisma.sepayTransaction.findMany({
      where: {
        OR: [
          { accountNumber: { in: special } },
          { subAccount: { in: special } },
        ],
        rawPayload: { not: Prisma.DbNull },
      },
      take: limit,
      orderBy: { id: 'desc' },
      select: {
        id: true,
        sepayId: true,
        rawPayload: true,
        transactionContent: true,
      },
    });

    let updated = 0;
    let skipped = 0;
    for (const row of targets) {
      const payload = row.rawPayload as any;
      // Sepay webhook payload: content
      // Sepay List API: transaction_content
      // MacroDroid SMS: body_message
      const original =
        payload?.content ??
        payload?.transaction_content ??
        payload?.body_message ??
        null;
      if (typeof original !== 'string' || !original.trim()) {
        skipped += 1;
        continue;
      }
      const next = original.trim();
      if (next === row.transactionContent) {
        skipped += 1;
        continue;
      }
      await this.prisma.sepayTransaction.update({
        where: { id: row.id },
        data: { transactionContent: next },
      });
      updated += 1;
    }

    this.logger.log(
      `Sepay backfill content: scanned=${targets.length}, updated=${updated}, skipped=${skipped}`,
    );
    return { updated, skipped, scanned: targets.length };
  }

  /**
   * Preview backfill CashFlow.description cho các phiếu thu liên quan Sepay.
   * KHÔNG ghi DB — chỉ trả về danh sách đầy đủ các phiếu thu sẽ bị sửa + nội dung mới.
   *
   * Tiêu chí lọc (ít nhất 1 trong 4):
   *   - CashFlow.sepayReferenceCode != null
   *   - Có InvoicePayment với cashFlowId = cf.id (status != hủy)
   *   - Có OrderPayment với cashFlowId = cf.id (status != hủy)
   *   - Có SepayAllocation với cashFlowId = cf.id
   *
   * Nội dung mới:
   *   - TK đặc biệt (env SEPAY_SPECIAL_ACCOUNT_NUMBERS) → transactionContent
   *   - Ngân hàng khác → referenceNumber
   *
   * Trả { scanned, willUpdate, skipped, items }.
   */
  async previewCashflowDescription(limit: number) {
    const items = await this.collectCashflowDescriptionChanges(limit, false);
    const willUpdate = items.filter((i) => i.willUpdate).length;
    const skipped = items.length - willUpdate;
    return {
      scanned: items.length,
      willUpdate,
      skipped,
      items,
    };
  }

  /**
   * Apply backfill CashFlow.description cho các phiếu thu liên quan Sepay.
   * Ghi DB. Idempotent — chạy lại không thay đổi record đã đúng.
   *
   * Trả { scanned, updated, skipped, items }.
   */
  async backfillCashflowDescription(limit: number, userId?: number) {
    const items = await this.collectCashflowDescriptionChanges(limit, true);
    let updated = 0;
    for (const item of items) {
      if (!item.willUpdate) continue;
      await this.prisma.cashFlow.update({
        where: { id: item.cashFlowId },
        data: { description: item.newDescription },
      });
      updated += 1;
    }
    const skipped = items.length - updated;
    this.logger.log(
      `Sepay backfill cashflow description: scanned=${items.length}, updated=${updated}, skipped=${skipped}, by user=${userId ?? 'system'}`,
    );
    return {
      scanned: items.length,
      updated,
      skipped,
      items,
    };
  }

  /**
   * Helper chung cho preview/apply: tính nội dung mới cho từng phiếu thu.
   *
   * Tiêu chí lọc phiếu thu liên quan Sepay (ít nhất 1 trong 3):
   *   1. CashFlow.sepayReferenceCode != null (cả webhook + biến động số dư)
   *   2. Có InvoicePayment với cashFlowId = cf.id (status != hủy) — webhook tạo
   *   3. Có SepayAllocation với cashFlowId = cf.id — biến động số dư
   *
   * Lưu ý: OrderPayment KHÔNG có quan hệ với CashFlow trong schema hiện tại
   * (order_payments table không có cột cash_flow_id). Vậy với OrderPayment từ
   * webhook Sepay sẽ không có CashFlow — không có gì để backfill.
   *
   * Query ngược: lấy cashFlowId từ InvoicePayment + SepayAllocation, sau đó
   * query CashFlow theo id.
   */
  private async collectCashflowDescriptionChanges(
    limit: number,
    _apply: boolean,
  ) {
    // 1. Lấy cashFlowId từ InvoicePayment (webhook tạo hóa đơn qua Sepay).
  //    Lọc sepayTransactionId != null để BỎ QUA payment thủ công từ trang KH.
    const invPayments = await this.prisma.invoicePayment.findMany({
      where: {
        cashFlowId: { not: null },
        sepayTransactionId: { not: null },
        status: { not: 2 },
      },
      select: {
        cashFlowId: true,
        sepayTransactionId: true,
        invoice: { select: { code: true } },
      },
      take: limit,
      orderBy: { id: 'desc' },
    });

    // 2. Lấy cashFlowId từ SepayAllocation (biến động số dư)
    const allocations = await this.prisma.sepayAllocation.findMany({
      where: {
        cashFlowId: { not: null },
      },
      select: {
        cashFlowId: true,
        sepayTransactionId: true,
        customerName: true,
      },
      take: limit,
      orderBy: { id: 'desc' },
    });

    // 2a. Map từ PK id (Int) của sepay_transactions → sepayId (String).
    //     SepayAllocation.sepayTransactionId là FK tới sepay_transactions.id (Int),
    //     không phải sepayId (String). Cần query để lấy sepayId tương ứng.
    const allocTxPks = Array.from(
      new Set(
        allocations
          .map((a) => a.sepayTransactionId)
          .filter((v): v is number => v != null),
      ),
    );
    const allocSepayTxs =
      allocTxPks.length > 0
        ? await this.prisma.sepayTransaction.findMany({
            where: { id: { in: allocTxPks } },
            select: { id: true, sepayId: true },
          })
        : [];
    const allocPkToSepayId = new Map(
      allocSepayTxs.map((t) => [t.id, t.sepayId]),
    );

    // 3. Gom cashFlowId, dedupe + map nguồn
    const cfMap = new Map<
      number,
      {
        source: 'webhook-invoice' | 'bien-dong-so-du' | 'webhook-sepay-ref';
        sepayTxId: string | null;
        refCode: string | null;
      }
    >();
    for (const p of invPayments) {
      if (!p.cashFlowId) continue;
      if (!cfMap.has(p.cashFlowId)) {
        cfMap.set(p.cashFlowId, {
          source: 'webhook-invoice',
          sepayTxId: p.sepayTransactionId,
          refCode: null,
        });
      }
    }
    for (const a of allocations) {
      if (!a.cashFlowId) continue;
      if (!cfMap.has(a.cashFlowId)) {
        // SepayAllocation.sepayTransactionId là Int (PK id của sepay_transactions).
        // Tra map để lấy sepayId (String) — key dùng để tra sepay_transactions.
        const sepayIdStr =
          a.sepayTransactionId != null
            ? allocPkToSepayId.get(a.sepayTransactionId) ?? null
            : null;
        cfMap.set(a.cashFlowId, {
          source: 'bien-dong-so-du',
          sepayTxId: sepayIdStr,
          refCode: null,
        });
      }
    }

    // 4. Lấy cashFlow theo id
    const cfIds = Array.from(cfMap.keys());
    let cashFlows =
      cfIds.length > 0
        ? await this.prisma.cashFlow.findMany({
            where: { id: { in: cfIds } },
            orderBy: { id: 'desc' },
            select: {
              id: true,
              code: true,
              description: true,
              accountId: true,
              sepayReferenceCode: true,
              account: {
                select: {
                  accountNumber: true,
                  bankCode: true,
                  bankName: true,
                },
              },
            },
          })
        : [];

    // 4b. Bổ sung: các phiếu thu có sepayReferenceCode nhưng KHÔNG qua
    //     InvoicePayment/SepayAllocation (vd: phiếu thu cũ tạo qua OrderPayment
    //     không có quan hệ với CashFlow, hoặc phiếu thu webhook có sepayReferenceCode
    //     nhưng InvoicePayment.sepayTransactionId = null do logic cũ).
    //     Đây là trường hợp phiếu thu CÓ sepayReferenceCode nhưng không có
    //     trong cfMap. Ta query trực tiếp bảng CashFlow.
    const resolvedIds = new Set(cashFlows.map((cf) => cf.id));
    const extraCfs = await this.prisma.cashFlow.findMany({
      where: {
        sepayReferenceCode: { not: null },
        id: { notIn: Array.from(resolvedIds) },
      },
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        id: true,
        code: true,
        description: true,
        accountId: true,
        sepayReferenceCode: true,
        account: {
          select: {
            accountNumber: true,
            bankCode: true,
            bankName: true,
          },
        },
      },
    });
    if (extraCfs.length > 0) {
      cashFlows = [...cashFlows, ...extraCfs];
      // Thêm vào cfMap với placeholder — sẽ resolve sepayTxId ở bước 5b.
      for (const cf of extraCfs) {
        if (!cfMap.has(cf.id)) {
          cfMap.set(cf.id, {
            source: 'webhook-sepay-ref',
            sepayTxId: null,
            refCode: cf.sepayReferenceCode ?? null,
          });
        }
      }
    }

    // 5. Gom sepayId (string) cần tra
    const sepayIds = new Set<string>();
    for (const info of cfMap.values()) {
      if (info.sepayTxId) sepayIds.add(info.sepayTxId);
    }

    const sepayTxs =
      sepayIds.size > 0
        ? await this.prisma.sepayTransaction.findMany({
            where: { sepayId: { in: Array.from(sepayIds) } },
            select: {
              sepayId: true,
              accountNumber: true,
              subAccount: true,
              transactionContent: true,
              referenceNumber: true,
            },
          })
        : [];

    const txBySepayId = new Map(sepayTxs.map((t) => [t.sepayId, t]));

    // 5b. Fallback: với các phiếu thu CHƯA resolve được qua InvoicePayment/SepayAllocation
    //     (sepayTxId vẫn null) nhưng có sepayReferenceCode, query trực tiếp
    //     sepay_transactions theo referenceNumber. Đây là trường hợp phiếu thu webhook
    //     có sepayReferenceCode nhưng InvoicePayment.sepayTransactionId = null
    //     (vd: phiếu thu tạo qua OrderPayment không có quan hệ với CashFlow, hoặc
    //     InvoicePayment.sepayTransactionId chưa được set do lỗi logic cũ).
    const unresolvedCfs = cashFlows.filter(
      (cf) => !cfMap.get(cf.id)?.sepayTxId && cf.sepayReferenceCode,
    );
    if (unresolvedCfs.length > 0) {
      const refCodes = unresolvedCfs
        .map((cf) => cf.sepayReferenceCode!)
        .filter(Boolean);
      if (refCodes.length > 0) {
        const txsByRef = await this.prisma.sepayTransaction.findMany({
          where: { referenceNumber: { in: refCodes } },
          select: {
            sepayId: true,
            referenceNumber: true,
            accountNumber: true,
            subAccount: true,
            transactionContent: true,
          },
        });
        const refToSepayId = new Map<string, string>();
        for (const t of txsByRef) {
          if (t.referenceNumber) refToSepayId.set(t.referenceNumber, t.sepayId);
        }
        // Map sepayId → full tx info để tra sau
        for (const t of txsByRef) {
          if (t.sepayId && !txBySepayId.has(t.sepayId)) {
            txBySepayId.set(t.sepayId, t);
          }
        }
        // Cập nhật cfMap với sepayTxId resolve được
        for (const cf of unresolvedCfs) {
          const sepayId = refToSepayId.get(cf.sepayReferenceCode!);
          if (sepayId) {
            cfMap.set(cf.id, {
              source: 'webhook-sepay-ref',
              sepayTxId: sepayId,
              refCode: cf.sepayReferenceCode,
            });
          }
        }
      }
    }

    const items: any[] = [];
    for (const cf of cashFlows) {
      const info = cfMap.get(cf.id)!;
      const sepayTx = info.sepayTxId
        ? txBySepayId.get(info.sepayTxId)
        : null;

      const isSpecial = await isSepaySpecialAccount(
        this.prisma,
        sepayTx?.accountNumber ?? null,
        sepayTx?.subAccount ?? null,
      );

      let newDescription: string | null = null;
      if (sepayTx) {
        newDescription = isSpecial
          ? (sepayTx.transactionContent || '').trim()
          : (sepayTx.referenceNumber || '').trim();
      }

      const currentDescription = cf.description ?? '';
      const willUpdate =
        newDescription !== null && newDescription !== currentDescription;

      items.push({
        cashFlowId: cf.id,
        cashFlowCode: cf.code,
        currentDescription: cf.description,
        newDescription,
        willUpdate,
        source: info.source,
        bankAccountNumber: cf.account?.accountNumber ?? null,
        bankCode: cf.account?.bankCode ?? null,
        bankName: cf.account?.bankName ?? null,
        isSpecialAccount: isSpecial,
        sepayTransactionId: info.sepayTxId,
        sepayReferenceCode: cf.sepayReferenceCode,
        transactionContent: sepayTx?.transactionContent ?? null,
        referenceNumber: sepayTx?.referenceNumber ?? null,
      });
    }

    // Sắp xếp theo id desc (cashFlow mới nhất trước)
    items.sort((a, b) => b.cashFlowId - a.cashFlowId);
    return items.slice(0, limit);
  }

  /**
   * Preview backfill accountId cho các phiếu thu liên quan Sepay.
   * KHÔNG ghi DB. Trả danh sách đầy đủ các phiếu thu có accountId = null
   * nhưng có thể resolve được từ sepay_transactions (subAccount/accountNumber).
   *
   * Trả { scanned, willUpdate, skipped, items }.
   */
  async previewCashflowAccount(limit: number) {
    const items = await this.collectCashflowAccountChanges(limit);
    const willUpdate = items.filter((i) => i.willUpdate).length;
    const skipped = items.length - willUpdate;
    return {
      scanned: items.length,
      willUpdate,
      skipped,
      items,
    };
  }

  /**
   * Apply backfill accountId cho các phiếu thu liên quan Sepay.
   * Ghi DB. Idempotent.
   *
   * Trả { scanned, updated, skipped, items }.
   */
  async backfillCashflowAccount(limit: number, userId?: number) {
    const items = await this.collectCashflowAccountChanges(limit);
    let updated = 0;
    for (const item of items) {
      if (!item.willUpdate) continue;
      await this.prisma.cashFlow.update({
        where: { id: item.cashFlowId },
        data: { accountId: item.newAccountId },
      });
      updated += 1;
    }
    const skipped = items.length - updated;
    this.logger.log(
      `Sepay backfill cashflow accountId: scanned=${items.length}, updated=${updated}, skipped=${skipped}, by user=${userId ?? 'system'}`,
    );
    return {
      scanned: items.length,
      updated,
      skipped,
      items,
    };
  }

  /**
   * Helper chung cho preview/apply accountId.
   * Tìm các phiếu thu Sepay có accountId = null, resolve lại từ
   * sepay_transactions.subAccount (ưu tiên) / accountNumber.
   *
   * Tiêu chí lọc: phiếu thu liên quan Sepay (qua InvoicePayment.sepayTransactionId
   * hoặc SepayAllocation) VÀ accountId = null.
   */
  private async collectCashflowAccountChanges(limit: number) {
    // 1. Lấy cashFlowId từ InvoicePayment (webhook Sepay)
    const invPayments = await this.prisma.invoicePayment.findMany({
      where: {
        cashFlowId: { not: null },
        sepayTransactionId: { not: null },
        status: { not: 2 },
      },
      select: { cashFlowId: true, sepayTransactionId: true },
      take: limit,
      orderBy: { id: 'desc' },
    });

    // 2. Lấy cashFlowId từ SepayAllocation (biến động số dư)
    const allocations = await this.prisma.sepayAllocation.findMany({
      where: { cashFlowId: { not: null } },
      select: { cashFlowId: true, sepayTransactionId: true },
      take: limit,
      orderBy: { id: 'desc' },
    });

    // 3. Map PK id (sepay_transactions.id) → sepayId (string)
    const allocTxPks = Array.from(
      new Set(
        allocations
          .map((a) => a.sepayTransactionId)
          .filter((v): v is number => v != null),
      ),
    );
    const allocSepayTxs =
      allocTxPks.length > 0
        ? await this.prisma.sepayTransaction.findMany({
            where: { id: { in: allocTxPks } },
            select: { id: true, sepayId: true },
          })
        : [];
    const allocPkToSepayId = new Map(
      allocSepayTxs.map((t) => [t.id, t.sepayId]),
    );

    // 4. Gom cashFlowId + sepayTxId (string)
    const cfToSepayTxId = new Map<number, string | null>();
    for (const p of invPayments) {
      if (p.cashFlowId && !cfToSepayTxId.has(p.cashFlowId)) {
        cfToSepayTxId.set(p.cashFlowId, p.sepayTransactionId);
      }
    }
    for (const a of allocations) {
      if (a.cashFlowId && !cfToSepayTxId.has(a.cashFlowId)) {
        const sepayIdStr =
          a.sepayTransactionId != null
            ? allocPkToSepayId.get(a.sepayTransactionId) ?? null
            : null;
        cfToSepayTxId.set(a.cashFlowId, sepayIdStr);
      }
    }

    // 5. Lấy CashFlow có accountId = null VÀ id trong tập cfToSepayTxId
    const cfIds = Array.from(cfToSepayTxId.keys());
    let cashFlows =
      cfIds.length > 0
        ? await this.prisma.cashFlow.findMany({
            where: {
              id: { in: cfIds },
              accountId: null,
            },
            orderBy: { id: 'desc' },
            select: { id: true, code: true, accountId: true, sepayReferenceCode: true },
          })
        : [];

    // 5b. Bổ sung: phiếu thu có sepayReferenceCode mà KHÔNG qua
    //     InvoicePayment/SepayAllocation (vd: webhook phiếu thu đơn hàng không
    //     có quan hệ với CashFlow, hoặc InvoicePayment.sepayTransactionId null).
    const resolvedIds = new Set(cashFlows.map((cf) => cf.id));
    const extraCfs = await this.prisma.cashFlow.findMany({
      where: {
        sepayReferenceCode: { not: null },
        accountId: null,
        id: { notIn: Array.from(resolvedIds) },
      },
      orderBy: { id: 'desc' },
      take: limit,
      select: { id: true, code: true, accountId: true, sepayReferenceCode: true },
    });
    if (extraCfs.length > 0) {
      cashFlows = [...cashFlows, ...extraCfs];
      // Map sepayReferenceCode → sepayId (sẽ resolve ở bước 6b).
      for (const cf of extraCfs) {
        if (cf.sepayReferenceCode) {
          cfToSepayTxId.set(cf.id, null); // placeholder; sẽ lookup bằng referenceNumber
        }
      }
    }

    if (cashFlows.length === 0) {
      return [];
    }

    // 6. Lấy sepay_transactions theo sepayId (đã resolve)
    const sepayIds = new Set<string>();
    for (const id of cfIds) {
      const sid = cfToSepayTxId.get(id);
      if (sid) sepayIds.add(sid);
    }

    // 6b. Fallback: query sepay_transactions theo referenceNumber cho các
    //     phiếu thu chưa resolve được qua sepayId (nhóm bổ sung ở bước 5b).
    const refCodeToCfId = new Map<string, number>();
    for (const cf of cashFlows) {
      if (cf.sepayReferenceCode && !cfToSepayTxId.get(cf.id)) {
        refCodeToCfId.set(cf.sepayReferenceCode, cf.id);
      }
    }
    if (refCodeToCfId.size > 0) {
      const refCodes = Array.from(refCodeToCfId.keys());
      const txsByRef = await this.prisma.sepayTransaction.findMany({
        where: { referenceNumber: { in: refCodes } },
        select: {
          sepayId: true,
          referenceNumber: true,
          accountNumber: true,
          subAccount: true,
        },
      });
      for (const t of txsByRef) {
        if (t.referenceNumber && refCodeToCfId.has(t.referenceNumber)) {
          const cfId = refCodeToCfId.get(t.referenceNumber)!;
          cfToSepayTxId.set(cfId, t.sepayId);
        }
      }
    }

    // Re-build sepayIds sau khi resolve thêm
    const allSepayIds = new Set<string>();
    for (const id of cashFlows.map((cf) => cf.id)) {
      const sid = cfToSepayTxId.get(id);
      if (sid) allSepayIds.add(sid);
    }

    const sepayTxs =
      allSepayIds.size > 0
        ? await this.prisma.sepayTransaction.findMany({
            where: { sepayId: { in: Array.from(allSepayIds) } },
            select: {
              sepayId: true,
              accountNumber: true,
              subAccount: true,
            },
          })
        : [];
    const txBySepayId = new Map(sepayTxs.map((t) => [t.sepayId, t]));

    // 7. Resolve accountId cho mỗi phiếu thu
    const items: any[] = [];
    for (const cf of cashFlows) {
      const sid = cfToSepayTxId.get(cf.id);
      if (!sid) continue;
      const tx = txBySepayId.get(sid);
      if (!tx) continue;

      // Ưu tiên subAccount (VA) trước, fallback accountNumber (TK chính)
      const candidates = [tx.subAccount, tx.accountNumber].filter(
        (v): v is string => !!v,
      );
      let bankAccount: { id: number; accountNumber: string; bankCode: string; bankName: string } | null =
        null;
      for (const acc of candidates) {
        bankAccount = await this.prisma.bankAccount.findFirst({
          where: { accountNumber: acc },
          select: {
            id: true,
            accountNumber: true,
            bankCode: true,
            bankName: true,
          },
        });
        if (bankAccount) break;
      }

      items.push({
        cashFlowId: cf.id,
        cashFlowCode: cf.code,
        currentAccountId: cf.accountId,
        newAccountId: bankAccount?.id ?? null,
        willUpdate: bankAccount !== null,
        sepayTransactionId: sid,
        sepayAccountNumber: tx.accountNumber,
        sepaySubAccount: tx.subAccount,
        resolvedAccountNumber: bankAccount?.accountNumber ?? null,
        resolvedBankCode: bankAccount?.bankCode ?? null,
        resolvedBankName: bankAccount?.bankName ?? null,
      });
    }

    items.sort((a, b) => b.cashFlowId - a.cashFlowId);
    return items.slice(0, limit);
  }
}
