import { readNumber, readText } from './legacy-fund-reconcile';
import { PrismaClient } from '@prisma/client';
import { plateHints, vnDay } from './lark-twin-dedupe';

/**
 * Đối chiếu (chỉ đọc) tổng Phiếu chi kho trên POS với bảng "Tổng hợp phiếu chi
 * kho HN/SG" trên LarkBase theo từng dòng (record Lark ↔ sourceKey
 * `LARK:<base>:<table>:<recordId>`), chia phần chênh theo nguyên nhân.
 * Chênh lệch = tổng POS − tổng Lark = tổng phần đóng góp của các nhóm.
 */
export const EXPENSE_TABLES = {
  HN: { branchId: 6, tableId: 'tblsU8sAtDJA9jHl', department: 'Kho Hà Nội' },
  SG: { branchId: 1, tableId: 'tblcNqgYpTpNwX2X', department: 'Kho Sài Gòn' },
} as const;

export interface LarkExpenseRow {
  recordId: string;
  day: string | null;
  /** Thời điểm chính xác (ms) của cột ngày, để ghép với phiếu xe gốc. */
  ms?: number;
  amount: number;
  department: string;
  content: string;
  note: string;
  slipCode: string;
}

export interface PosExpenseRow {
  id: number;
  code: string;
  occurredAt: Date;
  amount: number;
  status: string;
  sourceType: string;
  sourceKey: string | null;
  category: string;
  description: string | null;
  note: string | null;
  cancelReason: string | null;
}

const field = (fields: Record<string, unknown>, ...names: string[]) => {
  for (const name of names) {
    const text = readText(fields[name]).trim();
    if (text) return text;
  }
  return '';
};

export function mapLarkExpense(record: {
  recordId: string;
  fields: Record<string, unknown>;
}): LarkExpenseRow {
  const raw = record.fields['NĂM/THÁNG/NGÀY'];
  const ms = readNumber(raw);
  return {
    recordId: record.recordId,
    day: ms > 0 ? vnDay(new Date(ms)) : null,
    ms: ms > 0 ? ms : undefined,
    amount: readNumber(record.fields['THÀNH TIỀN']),
    department: field(record.fields, 'Phòng ban'),
    content: field(record.fields, 'NỘI DUNG', 'Nội Dung'),
    note: field(record.fields, 'GHI CHÚ', 'Ghi chú'),
    slipCode: field(record.fields, 'Mã Báo Đơn', 'Mã báo đơn'),
  };
}

export type CompareGroup =
  | 'matched'
  | 'vehicleCopySkipped'
  | 'vehicleCopyMerged'
  | 'posVehicleNoCopy'
  | 'amountDiff'
  | 'larkNotImported'
  | 'larkOtherDepartment'
  | 'larkCancelledOnPos'
  | 'dateShift'
  | 'posVehicleTable'
  | 'posPackingSlip'
  | 'posCreated'
  | 'posDeletedOnLark'
  | 'posOtherLark';

export const GROUP_LABEL: Record<CompareGroup, string> = {
  matched: 'Khớp',
  vehicleCopySkipped:
    'Phiếu xe khớp dòng Lark (POS giữ phiếu xe, bỏ dòng phiếu chi lúc nhập)',
  vehicleCopyMerged:
    'Phiếu xe khớp dòng Lark đã gộp bằng dedupe:lark-twins (bản sao đã hủy)',
  posVehicleNoCopy:
    'Chỉ có trên POS: phiếu xe không có dòng ở bảng phiếu chi Lark',
  amountDiff: 'Lệch số tiền (sửa trên Lark sau khi đồng bộ?)',
  larkNotImported: 'Chỉ có trên Lark: chưa nhập vào POS',
  larkOtherDepartment:
    'Chỉ có trên Lark: phòng ban khác, POS không tính vào kho',
  larkCancelledOnPos: 'Có trên Lark nhưng đã hủy trên POS',
  dateShift: 'Lệch ngày (nằm ngoài khoảng ở một bên)',
  posVehicleTable: 'Chỉ có trên POS: phiếu xe nhập từ bảng xe Lark (nhập đôi)',
  posPackingSlip: 'Chỉ có trên POS: phiếu sinh từ báo đơn POS',
  posCreated: 'Chỉ có trên POS: phiếu tạo trên POS',
  posDeletedOnLark: 'Chỉ có trên POS: dòng đã bị xóa khỏi bảng Lark',
  posOtherLark: 'Chỉ có trên POS: nhập từ bảng Lark khác',
};

export interface CompareLine {
  group: CompareGroup;
  /** Phần đóng góp vào chênh lệch (POS − Lark). */
  delta: number;
  lark?: LarkExpenseRow;
  pos?: PosExpenseRow;
}

const recordOf = (sourceKey: string | null, tableId: string) => {
  const parts = (sourceKey || '').split(':');
  return parts[0] === 'LARK' && parts[2] === tableId ? parts[3] : null;
};

/**
 * `larkRows`: toàn bộ bảng; `posInRange`: phiếu POS khớp bộ lọc trang Phiếu chi
 * kho (không tính phiếu hủy); `posByRecord`: mọi phiếu POS (kể cả hủy, ngoài
 * khoảng) có record Lark của bảng này.
 */
export function compareExpenses(input: {
  tableId: string;
  department: string;
  from: string;
  to: string;
  larkRows: LarkExpenseRow[];
  posInRange: PosExpenseRow[];
  posByRecord: Map<string, PosExpenseRow>;
}) {
  const inRange = (day: string | null) =>
    Boolean(day && day >= input.from && day <= input.to);
  const lines: CompareLine[] = [];
  const larkInRange = input.larkRows.filter((row) => inRange(row.day));
  const larkIds = new Set(input.larkRows.map((row) => row.recordId));
  const posInRangeIds = new Set(input.posInRange.map((row) => row.id));

  for (const lark of larkInRange) {
    const pos = input.posByRecord.get(lark.recordId);
    if (!pos) {
      const other = lark.department && lark.department !== input.department;
      lines.push({
        group: other ? 'larkOtherDepartment' : 'larkNotImported',
        delta: -lark.amount,
        lark,
      });
    } else if (pos.status === 'CANCELLED')
      lines.push({
        group: 'larkCancelledOnPos',
        delta: -lark.amount,
        lark,
        pos,
      });
    else if (!posInRangeIds.has(pos.id))
      lines.push({ group: 'dateShift', delta: -lark.amount, lark, pos });
    else if (pos.amount !== lark.amount)
      lines.push({
        group: 'amountDiff',
        delta: pos.amount - lark.amount,
        lark,
        pos,
      });
    else lines.push({ group: 'matched', delta: 0, lark, pos });
  }

  const larkInRangeIds = new Set(larkInRange.map((row) => row.recordId));
  for (const pos of input.posInRange) {
    const record = recordOf(pos.sourceKey, input.tableId);
    if (record && larkInRangeIds.has(record)) continue;
    let group: CompareGroup;
    if (record) group = larkIds.has(record) ? 'dateShift' : 'posDeletedOnLark';
    else if (pos.sourceType === 'LARK_IMPORT')
      group = ['FUEL', 'VEHICLE_CARE'].includes(pos.category)
        ? 'posVehicleTable'
        : 'posOtherLark';
    else if (pos.sourceType === 'PACKING_SLIP') group = 'posPackingSlip';
    else group = 'posCreated';
    const lark = record
      ? input.larkRows.find((row) => row.recordId === record)
      : undefined;
    lines.push({ group, delta: pos.amount, pos, lark });
  }

  // Dòng phiếu chi Lark chưa nhập vì POS đã giữ phiếu xe gốc của nó (bước bỏ
  // trùng lúc đồng bộ): ghép cùng thời điểm (tới giây), rồi cùng ngày + cùng
  // tiền khi chỉ có đúng một phiếu xe. Cặp ghép được là cùng một khoản chi.
  pairVehicleCopies(lines);

  const larkTotal = larkInRange.reduce((sum, row) => sum + row.amount, 0);
  const larkDepartment = larkInRange
    .filter((row) => !row.department || row.department === input.department)
    .reduce((sum, row) => sum + row.amount, 0);
  const posTotal = input.posInRange.reduce((sum, row) => sum + row.amount, 0);
  const byGroup = new Map<CompareGroup, { count: number; delta: number }>();
  for (const line of lines) {
    const current = byGroup.get(line.group) || { count: 0, delta: 0 };
    byGroup.set(line.group, {
      count: current.count + 1,
      delta: current.delta + line.delta,
    });
  }
  return { lines, larkTotal, larkDepartment, posTotal, byGroup };
}

function pairVehicleCopies(lines: CompareLine[]) {
  const vehicles = lines.filter((line) => line.group === 'posVehicleTable');
  const used = new Set<CompareLine>();
  const take = (vehicle: CompareLine) => {
    used.add(vehicle);
    vehicle.group = 'matched';
    vehicle.delta = 0;
    vehicle.pos = undefined;
  };

  // Bản sao đã được dedupe:lark-twins hủy: lý do hủy ghi mã phiếu xe giữ lại.
  for (const copy of lines.filter((l) => l.group === 'larkCancelledOnPos')) {
    const code = /Trùng với phiếu (?:xe|báo đơn) (\S+)/.exec(
      copy.pos?.cancelReason || '',
    )?.[1];
    const vehicle = code
      ? vehicles.find((v) => !used.has(v) && v.pos!.code === code)
      : undefined;
    if (!vehicle) continue;
    copy.group = 'vehicleCopyMerged';
    copy.delta = vehicle.pos!.amount - copy.lark!.amount;
    copy.pos = vehicle.pos;
    take(vehicle);
  }

  const copies = lines.filter((line) => line.group === 'larkNotImported');
  const merge = (copy: CompareLine, vehicle: CompareLine) => {
    copy.group = 'vehicleCopySkipped';
    copy.pos = vehicle.pos;
    copy.delta = vehicle.pos!.amount - copy.lark!.amount;
    take(vehicle);
  };
  const second = (ms: number) => Math.floor(ms / 1000);
  const sameAmount = (copy: CompareLine) => (v: CompareLine) =>
    !used.has(v) && v.pos!.amount === copy.lark!.amount;
  const sameDay = (copy: CompareLine) => (v: CompareLine) =>
    vnDay(v.pos!.occurredAt) === copy.lark!.day;
  const samePlate = (copy: CompareLine) => {
    const hints = plateHints(`${copy.lark!.content} ${copy.lark!.note}`);
    return (v: CompareLine) => {
      const plate = plateHints(v.pos!.description || '');
      return hints.some((hint) => plate.some((p) => p.includes(hint)));
    };
  };
  const passes: Array<(copy: CompareLine) => (v: CompareLine) => boolean> = [
    // 1. Cùng thời điểm (tới giây).
    (copy) => (v) =>
      Boolean(copy.lark!.ms) &&
      second(v.pos!.occurredAt.getTime()) === second(copy.lark!.ms!),
    // 2. Cùng ngày + cùng biển số.
    (copy) => {
      const plate = samePlate(copy);
      return (v) => sameDay(copy)(v) && plate(v);
    },
    // 3. Cùng ngày, chỉ có đúng một phiếu xe cùng tiền.
    sameDay,
  ];
  for (const pass of passes)
    for (const copy of copies) {
      if (copy.group !== 'larkNotImported') continue;
      const filter = pass(copy);
      const found = vehicles.filter((v) => sameAmount(copy)(v) && filter(v));
      if (found.length === 1) merge(copy, found[0]);
    }

  // Phiếu xe đã ghép xong không còn dòng riêng.
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i].group === 'matched' && !lines[i].lark && !lines[i].pos)
      lines.splice(i, 1);
  for (const line of lines)
    if (line.group === 'posVehicleTable') line.group = 'posVehicleNoCopy';
}

/** Trước ngày dùng POS: dữ liệu chuyển từ Lark, Lark là số đúng. */
export const LARK_ERA_END = new Date('2026-10-13T00:00:00+07:00');
export const NO_COPY_REASON =
  'Không có trên bảng tổng hợp phiếu chi kho Lark (đối chiếu Lark)';

/**
 * Hủy phiếu xe chuyển từ Lark không có dòng ở bảng phiếu chi Lark: Lark không
 * tính khoản này nên POS cũng không tính. Bỏ Đã chi, gỡ khỏi tuần (tuần chưa
 * gửi thì trừ tổng, tuần đã gửi giữ tổng của Lark). Phiếu có giao dịch quỹ
 * POS đang ghi sổ thì không đụng, chỉ báo lại.
 */
export async function cancelVehicleNoCopy(
  prisma: PrismaClient,
  entryIds: number[],
  userId: number,
) {
  return prisma.$transaction(
    async (tx) => {
      const entries = await tx.internalFinanceEntry.findMany({
        where: {
          id: { in: entryIds },
          sourceType: 'LARK_IMPORT',
          category: { in: ['FUEL', 'VEHICLE_CARE'] },
          status: { not: 'CANCELLED' },
          occurredAt: { lt: LARK_ERA_END },
        },
        include: {
          fundTransaction: { select: { code: true, status: true } },
          weeklyBatch: { select: { status: true } },
        },
      });
      for (const branchId of [...new Set(entries.map((e) => e.branchId))].sort(
        (a, b) => a - b,
      ))
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(68125, ${branchId}::integer)`;
      const cancelled: string[] = [];
      const skipped: Array<{ code: string; reason: string }> = [];
      const now = new Date();
      for (const entry of entries) {
        if (entry.fundTransaction?.status === 'POSTED') {
          skipped.push({
            code: entry.code,
            reason: `Có giao dịch quỹ ${entry.fundTransaction.code}`,
          });
          continue;
        }
        if (entry.cashFlowId) {
          skipped.push({
            code: entry.code,
            reason: 'Có phiếu sổ quỹ cửa hàng',
          });
          continue;
        }
        if (entry.weeklyBatchId && entry.weeklyBatch?.status === 'READY')
          await tx.internalFinanceWeeklyBatch.update({
            where: { id: entry.weeklyBatchId },
            data: { totalAmount: { decrement: entry.amount } },
          });
        await tx.internalFinanceReview.create({
          data: {
            entryId: entry.id,
            role: 'MANAGER',
            decision: 'CANCEL',
            reason: NO_COPY_REASON,
            reviewerId: userId,
          },
        });
        await tx.internalFinanceEntry.update({
          where: { id: entry.id },
          data: {
            status: 'CANCELLED',
            cancelReason: NO_COPY_REASON,
            cancelledAt: now,
            cancelledBy: userId,
            posManagedAt: now,
            weeklyBatchId: null,
            cashIssued: false,
            cashIssuedAt: null,
            cashIssuedBy: null,
            cashIssuedReason: null,
          },
        });
        cancelled.push(entry.code);
      }
      return { cancelled, skipped };
    },
    { timeout: 300_000, maxWait: 60_000 },
  );
}
