import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { join } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { LarkExpenseBaseService } from './lark-expense-base.service';
import { LarkUserDirectoryService } from './lark-user-directory.service';

/**
 * Sync mỗi loại phí (gửi bến / Grab / cước gửi hàng) trong PackingSlip
 * thành 1 record trong bảng "Tổng hợp phiếu chi" tương ứng kho HN/SG.
 *
 * Mapping:
 * - branchId === 6 → table HN (LARK_EXPENSE_TABLE_HN), Phòng ban = "Kho Hà Nội"
 * - branchId === 1 → table SG (LARK_EXPENSE_TABLE_SG), Phòng ban = "Kho Sài Gòn"
 *
 * Field map (HN/SG có khác nhau "Khoản Mục" vs "Khoản mục"):
 * - NĂM/THÁNG/NGÀY: ms timestamp (createdAt của packing slip)
 * - Phòng ban: tên kho
 * - NỘI DUNG: "<Tên phí> - <Tên KH (gộp)> - <Mã hoá đơn (gộp)>"
 * - Số lượng: 1
 * - ĐƠN GIÁ: số tiền phí
 * - Khoản Mục/Khoản mục: option name cố định
 * - Chứng từ: array { file_token } upload từ ExpenseFile
 * - Người Chi: [ { id: open_id } ] — match theo expensePayer.name
 */

interface FeeItem {
  amount: number;
  feeName: string;
}

interface PackingSlipForSync {
  id: number;
  code?: string | null;
  branchId: number;
  createdAt: Date | string;
  hasFeeGuiBen: boolean;
  feeGuiBen?: any;
  hasFeeGrab: boolean;
  feeGrab?: any;
  hasCuocGuiHang: boolean;
  cuocGuiHang?: any;
  larkExpenseRecordIds?: any;
  expensePayer?: {
    id: number;
    name: string;
    larkUserId?: string | null;
  } | null;
  expenseFiles?: Array<{
    fileUrl: string;
    fileName?: string | null;
    fileType?: string | null;
  }> | null;
  images?: Array<{
    imageUrl: string;
  }> | null;
  invoices?: Array<{
    invoice?: {
      code?: string | null;
      customer?: { name?: string | null } | null;
    } | null;
  }> | null;
}

@Injectable()
export class LarkExpenseSyncService {
  private readonly logger = new Logger(LarkExpenseSyncService.name);
  private readonly tableHN: string | null;
  private readonly tableSG: string | null;
  private readonly apiUrl: string;

  constructor(
    private readonly expenseBase: LarkExpenseBaseService,
    private readonly userDirectory: LarkUserDirectoryService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.tableHN = this.config.get<string>('LARK_EXPENSE_TABLE_HN') || null;
    this.tableSG = this.config.get<string>('LARK_EXPENSE_TABLE_SG') || null;
    this.apiUrl =
      this.config.get<string>('API_URL') ||
      this.config.get<string>('APP_PUBLIC_URL') ||
      'http://localhost:3060';
  }

  isEnabled(): boolean {
    return this.expenseBase.isEnabled();
  }

  /**
   * Push 1 packing slip → tối đa 3 record (mỗi phí 1 record).
   * Best-effort: lỗi từng phí không ảnh hưởng phí khác. Lỗi tổng thể chỉ log.
   */
  async syncPackingSlipExpenses(slip: PackingSlipForSync): Promise<void> {
    if (!this.expenseBase.isEnabled()) return;

    const target = this.resolveTable(slip.branchId);
    if (!target) {
      this.logger.warn(
        `PackingSlip #${slip.id}: branchId=${slip.branchId} không map sang bảng phiếu chi`,
      );
      return;
    }

    const fees: FeeItem[] = [];
    if (slip.hasFeeGuiBen) {
      const v = this.toNumber(slip.feeGuiBen);
      if (v > 0) fees.push({ amount: v, feeName: 'Phí gửi bến' });
    }
    if (slip.hasFeeGrab) {
      const v = this.toNumber(slip.feeGrab);
      if (v > 0) fees.push({ amount: v, feeName: 'Phí Grab' });
    }
    if (slip.hasCuocGuiHang) {
      const v = this.toNumber(slip.cuocGuiHang);
      if (v > 0) fees.push({ amount: v, feeName: 'Cước gửi hàng' });
    }

    if (fees.length === 0) return;

    const customerNames = this.uniq(
      (slip.invoices || [])
        .map((i) => i.invoice?.customer?.name?.trim())
        .filter((n): n is string => !!n),
    );
    const invoiceCodes = this.uniq(
      (slip.invoices || [])
        .map((i) => i.invoice?.code?.trim())
        .filter((c): c is string => !!c),
    );

    // Chuẩn bị attachments tokens (1 lần, dùng chung cho cả 3 phí).
    // Thứ tự: chứng từ chi phí trước, ảnh báo đơn sau.
    const expenseTokens = await this.uploadFilesByUrls(
      slip.id,
      (slip.expenseFiles || []).map((f) => ({
        url: f.fileUrl,
        fileName: f.fileName,
        fileType: f.fileType,
      })),
    );
    const imageTokens = await this.uploadFilesByUrls(
      slip.id,
      (slip.images || []).map((img) => ({ url: img.imageUrl })),
    );
    const attachmentTokens = [...expenseTokens, ...imageTokens];

    // Resolve người chi → open_id
    // Ưu tiên larkUserId đã lưu sẵn trong DB (pull từ Lark contact API qua
    // script `yarn sync:lark-users`). Fallback sang match-by-name nếu user
    // chưa có larkUserId.
    let payerField: any = undefined;
    if (slip.expensePayer) {
      const directOpenId = slip.expensePayer.larkUserId?.trim() || null;
      if (directOpenId) {
        payerField = [{ id: directOpenId }];
      } else if (slip.expensePayer.name) {
        try {
          const openId = await this.userDirectory.findOpenIdByName(
            slip.expensePayer.name,
          );
          if (openId) {
            payerField = [{ id: openId }];
          } else {
            this.logger.log(
              `PackingSlip #${slip.id}: không tìm thấy open_id cho người chi "${slip.expensePayer.name}" (chưa gán larkUserId) → để trống Người Chi`,
            );
          }
        } catch (err: any) {
          this.logger.warn(
            `Resolve người chi lỗi: ${err.message} — để trống Người Chi`,
          );
        }
      }
    }

    const baseFields = {
      'Mã Báo Đơn': slip.code || '',
      'NĂM/THÁNG/NGÀY': new Date(slip.createdAt).getTime(),
      'Phòng ban': target.phongBan,
      'Số lượng': 1,
      [target.khoanMucField]:
        'Cước gửi hàng cho khách: cước chành xe, ship nội thành',
      ...(attachmentTokens.length > 0 ? { 'Chứng từ': attachmentTokens } : {}),
      ...(payerField ? { 'Người Chi': payerField } : {}),
    };

    // Map feeName → recordId vừa tạo trên Lark, để lưu lại vào DB.
    const recordMap: Record<string, string> = {};

    // Record_id đã lưu trước đó (nếu phiếu từng sync). Chỉ tái sử dụng khi
    // cùng table (tránh dùng nhầm record_id của bảng HN cho bảng SG).
    const stored = this.parseStoredRecords(slip.larkExpenseRecordIds);
    const storedRecords: Record<string, string> =
      stored && stored.tableId === target.tableId ? stored.records : {};

    // Cache kết quả search theo mã báo đơn (chỉ gọi 1 lần khi cần fallback).
    let searchedByCode: Array<{ recordId: string; text: string }> | null = null;

    for (const fee of fees) {
      const noiDung = this.buildNoiDung(
        fee.feeName,
        customerNames,
        invoiceCodes,
      );
      const fields = {
        ...baseFields,
        'NỘI DUNG': noiDung,
        'ĐƠN GIÁ': fee.amount,
      };

      try {
        // ── Bước 1: đã có record_id lưu sẵn → update thẳng ──
        const knownId = storedRecords[fee.feeName];
        if (knownId) {
          try {
            await this.expenseBase.updateRecord(
              target.tableId,
              knownId,
              fields,
            );
            recordMap[fee.feeName] = knownId;
            this.logger.log(
              `Sync expense [${fee.feeName}] PackingSlip#${slip.id} → ${target.label} update record=${knownId}`,
            );
            continue;
          } catch (err: any) {
            if (!this.expenseBase.isRecordNotFound(err)) throw err;
            // record bị xoá trên Lark → rơi xuống search/create
            this.logger.warn(
              `Record ${knownId} không còn trên Lark (PackingSlip#${slip.id}, ${fee.feeName}) → search/create lại`,
            );
          }
        }

        // ── Bước 2: chưa có / record cũ bị xoá → search theo Mã Báo Đơn ──
        let matchedId: string | null = null;
        if (slip.code) {
          if (searchedByCode === null) {
            searchedByCode = await this.expenseBase.searchRecordsByField(
              target.tableId,
              'Mã Báo Đơn',
              slip.code,
              'NỘI DUNG',
            );
          }
          // Match đúng record của loại phí này qua NỘI DUNG (bắt đầu bằng tên phí).
          // Loại trừ record_id đã gán cho phí khác trong cùng lần chạy.
          const usedIds = new Set(Object.values(recordMap));
          const found = searchedByCode.find(
            (r) =>
              !usedIds.has(r.recordId) &&
              r.text.trim().startsWith(fee.feeName),
          );
          matchedId = found?.recordId || null;
        }

        if (matchedId) {
          await this.expenseBase.updateRecord(target.tableId, matchedId, fields);
          recordMap[fee.feeName] = matchedId;
          this.logger.log(
            `Sync expense [${fee.feeName}] PackingSlip#${slip.id} → ${target.label} matched+update record=${matchedId}`,
          );
          continue;
        }

        // ── Bước 3: không tìm thấy → tạo mới ──
        const recordId = await this.expenseBase.createRecord(
          target.tableId,
          fields,
        );
        if (recordId) {
          recordMap[fee.feeName] = recordId;
        }
        this.logger.log(
          `Sync expense [${fee.feeName}] PackingSlip#${slip.id} → ${target.label} create record=${recordId}`,
        );
      } catch (err: any) {
        this.logger.error(
          `Sync expense [${fee.feeName}] PackingSlip#${slip.id} → ${target.label} thất bại: ${err.message}`,
        );
      }
    }

    // Lưu record_id để sau này có thể cập nhật lại trên Lark (best-effort,
    // chỉ lưu khi có ít nhất 1 record tạo thành công).
    if (Object.keys(recordMap).length > 0) {
      try {
        await this.prisma.packingSlip.update({
          where: { id: slip.id },
          data: {
            larkExpenseRecordIds: {
              tableId: target.tableId,
              label: target.label,
              records: recordMap,
            },
            larkExpenseSyncedAt: new Date(),
          },
        });
      } catch (err: any) {
        this.logger.warn(
          `Lưu larkExpenseRecordIds PackingSlip#${slip.id} lỗi: ${err.message}`,
        );
      }
    }
  }

  private resolveTable(branchId: number): {
    tableId: string;
    phongBan: string;
    khoanMucField: 'Khoản Mục' | 'Khoản mục';
    label: string;
  } | null {
    if (branchId === 6 && this.tableHN) {
      return {
        tableId: this.tableHN,
        phongBan: 'Kho Hà Nội',
        khoanMucField: 'Khoản Mục',
        label: 'HN',
      };
    }
    if (branchId === 1 && this.tableSG) {
      return {
        tableId: this.tableSG,
        phongBan: 'Kho Sài Gòn',
        khoanMucField: 'Khoản mục',
        label: 'SG',
      };
    }
    return null;
  }

  /**
   * Đọc lại record_id đã lưu (cột larkExpenseRecordIds dạng Json).
   * Trả về { tableId, records } hoặc null nếu không hợp lệ.
   */
  private parseStoredRecords(
    raw: any,
  ): { tableId: string; records: Record<string, string> } | null {
    if (!raw || typeof raw !== 'object') return null;
    const tableId = typeof raw.tableId === 'string' ? raw.tableId : null;
    const records =
      raw.records && typeof raw.records === 'object' ? raw.records : null;
    if (!tableId || !records) return null;
    return { tableId, records };
  }

  private buildNoiDung(
    feeName: string,
    customerNames: string[],
    invoiceCodes: string[],
  ): string {
    const parts: string[] = [feeName];
    if (customerNames.length > 0) parts.push(customerNames.join(', '));
    if (invoiceCodes.length > 0) parts.push(invoiceCodes.join(', '));
    return parts.join(' - ');
  }

  /**
   * Upload list file local (uploads/...) lên Lark Drive (parent_type=bitable_file)
   * → trả về mảng `{ file_token }` để gắn vào field Attachment.
   * Dùng chung cho cả chứng từ chi phí lẫn ảnh báo đơn.
   */
  private async uploadFilesByUrls(
    slipId: number,
    files: Array<{ url: string; fileName?: string | null; fileType?: string | null }>,
  ): Promise<Array<{ file_token: string }>> {
    const baseToken = this.expenseBase.getBaseToken();
    if (!baseToken) return [];

    const tokens: Array<{ file_token: string }> = [];

    for (const f of files) {
      const localPath = this.resolveLocalPath(f.url);
      if (!localPath) {
        this.logger.warn(
          `PackingSlip #${slipId}: không resolve được file local từ url ${f.url}`,
        );
        continue;
      }
      try {
        if (!fs.existsSync(localPath)) {
          this.logger.warn(
            `PackingSlip #${slipId}: file không tồn tại ${localPath}`,
          );
          continue;
        }
        const buf = fs.readFileSync(localPath);
        const fileName = f.fileName || localPath.split('/').pop() || 'file';
        const fileToken = await this.expenseBase.uploadMediaForBitable(
          fileName,
          baseToken,
          buf,
          f.fileType || undefined,
        );
        if (fileToken) {
          tokens.push({ file_token: fileToken });
        }
      } catch (err: any) {
        this.logger.warn(
          `Upload file "${f.fileName || f.url}" PackingSlip#${slipId} lỗi: ${err.message}`,
        );
      }
    }

    return tokens;
  }

  /**
   * URL có dạng `${API_URL}/uploads/<subfolder>/<filename>`.
   * Trả về absolute path local; null nếu URL không thuộc API_URL hiện tại.
   */
  private resolveLocalPath(fileUrl: string): string | null {
    if (!fileUrl) return null;
    const marker = '/uploads/';
    const idx = fileUrl.indexOf(marker);
    if (idx < 0) return null;
    const relative = fileUrl.substring(idx + marker.length);
    if (!relative) return null;
    return join(process.cwd(), 'uploads', relative);
  }

  private toNumber(v: any): number {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseFloat(v) || 0;
    if (typeof v === 'object' && typeof v.toString === 'function') {
      const n = parseFloat(v.toString());
      return isNaN(n) ? 0 : n;
    }
    return 0;
  }

  private uniq<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
  }
}
