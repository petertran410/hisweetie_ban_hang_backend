import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Kiểm kê các dòng PĐN lịch sử thiếu factoryId, phân loại theo khả năng suy ra
 * nhà máy để quyết định dòng nào đủ tin cậy cho backfill lịch sử giá.
 *
 * Script CHỈ ĐỌC: không ghi/sửa/xóa bất kỳ bảng nào. Kết quả in ra bảng tổng
 * hợp và (tuỳ chọn) xuất CSV để đối chiếu thủ công.
 *
 * Mức tin cậy:
 *   HIGH   — FactoryChangeLog cho biết nhà máy tại đúng thời điểm PĐN.
 *   MEDIUM — Chỉ có duy nhất 1 nhà máy khả dĩ (mapping/primary/backup/NCC).
 *   LOW    — Có nhiều nhà máy khả dĩ, cần người dùng chọn.
 *   NONE   — Không tìm được nhà máy nào.
 *
 * Chạy:      yarn audit:order-supplier-factory
 * Xuất CSV:  yarn audit:order-supplier-factory --csv
 */

const prisma = new PrismaClient();
const EXPORT_CSV = process.argv.includes('--csv');
const CONFIRMED_STATUSES = [1, 2, 3];

type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

type AuditRow = {
  orderCode: string;
  orderDate: string;
  productCode: string;
  productName: string;
  factoryPrice: string;
  supplierName: string;
  confidence: Confidence;
  source: string;
  candidateIds: string;
  candidateNames: string;
};

async function main() {
  const orders = await prisma.orderSupplier.findMany({
    where: { status: { in: CONFIRMED_STATUSES } },
    orderBy: [{ orderDate: 'asc' }, { id: 'asc' }],
    include: {
      supplier: { select: { id: true, name: true } },
      items: {
        include: {
          product: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
    },
  });

  const productIds = [
    ...new Set(
      orders.flatMap((order) =>
        order.items
          .filter((item) => item.factoryId == null && item.factoryPrice != null)
          .map((item) => item.productId),
      ),
    ),
  ];

  const [mappings, changeLogs, factories] = await Promise.all([
    prisma.factory_products.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, factoryId: true, role: true },
    }),
    prisma.factoryChangeLog.findMany({
      where: { productId: { in: productIds } },
      orderBy: { createdAt: 'asc' },
      select: {
        productId: true,
        factoryId: true,
        role: true,
        createdAt: true,
      },
    }),
    prisma.factory.findMany({
      select: { id: true, name: true, supplierId: true },
    }),
  ]);

  const factoryById = new Map(
    factories.map((factory) => [factory.id, factory]),
  );
  const factoriesBySupplier = new Map<number, number[]>();
  for (const factory of factories) {
    if (factory.supplierId == null) continue;
    const list = factoriesBySupplier.get(factory.supplierId) ?? [];
    list.push(factory.id);
    factoriesBySupplier.set(factory.supplierId, list);
  }

  const mappingsByProduct = new Map<number, number[]>();
  for (const mapping of mappings) {
    const list = mappingsByProduct.get(mapping.productId) ?? [];
    list.push(mapping.factoryId);
    mappingsByProduct.set(mapping.productId, list);
  }

  const logsByProduct = new Map<number, typeof changeLogs>();
  for (const log of changeLogs) {
    const list = logsByProduct.get(log.productId) ?? [];
    list.push(log);
    logsByProduct.set(log.productId, list);
  }

  const stats: Record<Confidence, number> = {
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    NONE: 0,
  };
  const rows: AuditRow[] = [];
  let itemsScanned = 0;
  let alreadyHasFactory = 0;
  let missingPrice = 0;

  for (const order of orders) {
    for (const item of order.items) {
      itemsScanned++;
      if (item.factoryId != null) {
        alreadyHasFactory++;
        continue;
      }
      if (item.factoryPrice == null) {
        missingPrice++;
        continue;
      }

      // 1. FactoryChangeLog gần nhất TRƯỚC ngày đặt hàng → đúng theo lịch sử.
      const logs = (logsByProduct.get(item.productId) ?? []).filter(
        (log) => log.createdAt <= order.orderDate,
      );
      const latestLog = logs.length ? logs[logs.length - 1] : null;

      // 2. Các nguồn suy đoán theo dữ liệu hiện tại (mapping SP × nhà máy).
      const currentCandidates = new Set<number>();
      for (const factoryId of mappingsByProduct.get(item.productId) ?? []) {
        currentCandidates.add(factoryId);
      }

      // 3. Thu hẹp theo NCC của chính PĐN — nhà máy phải thuộc NCC đó.
      const supplierFactoryIds = new Set(
        factoriesBySupplier.get(order.supplierId) ?? [],
      );
      const narrowed = [...currentCandidates].filter((factoryId) =>
        supplierFactoryIds.has(factoryId),
      );
      const candidates = narrowed.length ? narrowed : [...currentCandidates];

      let confidence: Confidence;
      let source: string;
      let resolved: number[];

      if (latestLog) {
        confidence = 'HIGH';
        source = `FactoryChangeLog @ ${latestLog.createdAt.toISOString().slice(0, 10)} (${latestLog.role})`;
        resolved = [latestLog.factoryId];
      } else if (candidates.length === 1) {
        confidence = 'MEDIUM';
        source = narrowed.length
          ? 'Duy nhất 1 nhà máy khớp NCC của PĐN'
          : 'Duy nhất 1 nhà máy gắn với sản phẩm';
        resolved = candidates;
      } else if (candidates.length > 1) {
        confidence = 'LOW';
        source = `${candidates.length} nhà máy khả dĩ — cần chọn thủ công`;
        resolved = candidates;
      } else {
        confidence = 'NONE';
        source = 'Không tìm được nhà máy nào';
        resolved = [];
      }

      stats[confidence]++;
      rows.push({
        orderCode: order.code,
        orderDate: order.orderDate.toISOString().slice(0, 10),
        productCode: item.productCode,
        productName: item.productName,
        factoryPrice: String(item.factoryPrice),
        supplierName: order.supplier?.name ?? '',
        confidence,
        source,
        candidateIds: resolved.join(' | '),
        candidateNames: resolved
          .map((id) => factoryById.get(id)?.name ?? `#${id}`)
          .join(' | '),
      });
    }
  }

  console.log('\n=== KIỂM KÊ NHÀ MÁY CHO PĐN LỊCH SỬ (CHỈ ĐỌC) ===\n');
  console.table({
    ordersScanned: orders.length,
    itemsScanned,
    alreadyHasFactory,
    missingFactoryPrice: missingPrice,
    needResolve: rows.length,
  });

  console.log('\nPhân loại theo mức tin cậy:');
  console.table({
    'HIGH — theo FactoryChangeLog': stats.HIGH,
    'MEDIUM — duy nhất 1 nhà máy': stats.MEDIUM,
    'LOW — nhiều nhà máy, cần chọn': stats.LOW,
    'NONE — không có nhà máy': stats.NONE,
  });

  const lowSamples = rows
    .filter((row) => row.confidence === 'LOW')
    .slice(0, 10);
  if (lowSamples.length) {
    console.log('\nVí dụ dòng cần chọn thủ công (tối đa 10):');
    console.table(
      lowSamples.map((row) => ({
        PĐN: row.orderCode,
        Ngày: row.orderDate,
        SP: row.productCode,
        'Nhà máy khả dĩ': row.candidateNames,
      })),
    );
  }

  if (EXPORT_CSV) {
    const header = [
      'orderCode',
      'orderDate',
      'productCode',
      'productName',
      'factoryPrice',
      'supplierName',
      'confidence',
      'source',
      'candidateIds',
      'candidateNames',
    ];
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csv = [
      header.join(','),
      ...rows.map((row) =>
        header
          .map((key) => escape(String(row[key as keyof AuditRow])))
          .join(','),
      ),
    ].join('\n');
    const outPath = path.join(
      process.cwd(),
      `order-supplier-factory-audit-${Date.now()}.csv`,
    );
    fs.writeFileSync(outPath, `\uFEFF${csv}`, 'utf8');
    console.log(`\nĐã xuất CSV: ${outPath}`);
  } else {
    console.log('\nThêm --csv để xuất toàn bộ danh sách ra file đối chiếu.');
  }

  console.log('\nScript chỉ đọc — không có dữ liệu nào bị thay đổi.\n');
}

main()
  .catch((error) => {
    console.error('Order supplier factory audit failed:', error);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
