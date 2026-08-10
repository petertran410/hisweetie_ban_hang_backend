// Upsert quyền và cấu hình global cho module Dự kiến đặt hàng.
// Idempotent: không xóa dữ liệu, không tự gán quyền cho role/user.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  {
    name: 'purchasing_planning:view',
    resource: 'purchasing_planning',
    action: 'view',
    description: 'Xem danh sách và chi tiết đề xuất đặt hàng',
  },
  {
    name: 'purchasing_planning:run',
    resource: 'purchasing_planning',
    action: 'run',
    description: 'Chạy tính toán đề xuất đặt hàng',
  },
  {
    name: 'purchasing_planning:config',
    resource: 'purchasing_planning',
    action: 'config',
    description: 'Quản lý cấu hình hoạch định đặt hàng',
  },
  {
    name: 'purchasing_planning:export',
    resource: 'purchasing_planning',
    action: 'export',
    description: 'Xuất danh sách đề xuất đặt hàng',
  },
] as const;

// PRD §14.2 — cấu hình khởi điểm; có thể override theo category/supplier/SKU.
const GLOBAL_CONFIG = {
  leadTimeDays: 30,
  safetyDays: 14,
  coverageDays: 30,
  growthFactor: 1,
  moq: 1,
} as const;

async function main() {
  // Prisma schema không mô tả được partial unique index; deploy hiện dùng
  // db push nên seed bảo đảm các invariant này tồn tại ở mọi môi trường.
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_calc_run_lock
    ON calculation_run (snapshot_date, run_type)
    WHERE status = 'RUNNING'
  `;
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_reco_active_date
    ON purchase_recommendation (snapshot_date)
    WHERE status = 'ACTIVE'
  `;
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_planning_config_active
    ON planning_config (scope_type, COALESCE(scope_id, -1), param_key)
    WHERE is_active = true
  `;

  for (const permission of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({
      where: { name: permission.name },
    });
    if (existing) {
      await prisma.permission.update({
        where: { name: permission.name },
        data: {
          category: 'Mua hàng',
          description: permission.description,
        },
      });
    } else {
      await prisma.permission.create({
        data: {
          ...permission,
          scope: 'all',
          category: 'Mua hàng',
        },
      });
    }
  }

  for (const [paramKey, paramValue] of Object.entries(GLOBAL_CONFIG)) {
    const existing = await prisma.planningConfig.findFirst({
      where: { scopeType: 'GLOBAL', scopeId: null, paramKey, isActive: true },
    });
    if (!existing) {
      await prisma.planningConfig.create({
        data: {
          scopeType: 'GLOBAL',
          scopeId: null,
          paramKey,
          paramValue,
          note: 'Cấu hình mặc định PRD §14.2',
        },
      });
    }
  }

  console.log(
    `Đã upsert ${PERMISSIONS.length} quyền và ${Object.keys(GLOBAL_CONFIG).length} cấu hình Purchasing Planning.`,
  );
}

main()
  .catch((error) => {
    console.error('Không thể seed Purchasing Planning:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
