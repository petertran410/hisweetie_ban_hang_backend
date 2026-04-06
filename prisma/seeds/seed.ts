import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const adminRole = await prisma.role.upsert({
    where: { name: 'Administrator' },
    update: {},
    create: {
      name: 'Administrator',
      description: 'Full system access',
    },
  });

  const userRole = await prisma.role.upsert({
    where: { name: 'User' },
    update: {},
    create: {
      name: 'User',
      description: 'Basic user access',
    },
  });

  const permissions = [
    {
      resource: 'products',
      action: 'view',
      name: 'products.view',
      scope: 'all',
      category: 'products',
    },
    {
      resource: 'products',
      action: 'create',
      name: 'products.create',
      scope: 'all',
      category: 'products',
    },
    {
      resource: 'products',
      action: 'update',
      name: 'products.update',
      scope: 'all',
      category: 'products',
    },
    {
      resource: 'products',
      action: 'delete',
      name: 'products.delete',
      scope: 'all',
      category: 'products',
    },

    {
      resource: 'orders',
      action: 'view',
      name: 'orders.view',
      scope: 'all',
      category: 'orders',
    },
    {
      resource: 'orders',
      action: 'create',
      name: 'orders.create',
      scope: 'all',
      category: 'orders',
    },
    {
      resource: 'orders',
      action: 'update',
      name: 'orders.update',
      scope: 'all',
      category: 'orders',
    },
    {
      resource: 'orders',
      action: 'delete',
      name: 'orders.delete',
      scope: 'all',
      category: 'orders',
    },

    {
      resource: 'customers',
      action: 'view',
      name: 'customers.view',
      scope: 'all',
      category: 'customers',
    },
    {
      resource: 'customers',
      action: 'create',
      name: 'customers.create',
      scope: 'all',
      category: 'customers',
    },
    {
      resource: 'customers',
      action: 'update',
      name: 'customers.update',
      scope: 'all',
      category: 'customers',
    },
    {
      resource: 'customers',
      action: 'delete',
      name: 'customers.delete',
      scope: 'all',
      category: 'customers',
    },

    {
      resource: 'suppliers',
      action: 'view',
      name: 'suppliers.view',
      scope: 'all',
      category: 'suppliers',
    },
    {
      resource: 'suppliers',
      action: 'create',
      name: 'suppliers.create',
      scope: 'all',
      category: 'suppliers',
    },
    {
      resource: 'suppliers',
      action: 'update',
      name: 'suppliers.update',
      scope: 'all',
      category: 'suppliers',
    },
    {
      resource: 'suppliers',
      action: 'delete',
      name: 'suppliers.delete',
      scope: 'all',
      category: 'suppliers',
    },

    {
      resource: 'purchase_orders',
      action: 'view',
      name: 'purchase_orders.view',
      scope: 'all',
      category: 'purchase_orders',
    },
    {
      resource: 'purchase_orders',
      action: 'create',
      name: 'purchase_orders.create',
      scope: 'all',
      category: 'purchase_orders',
    },
    {
      resource: 'purchase_orders',
      action: 'update',
      name: 'purchase_orders.update',
      scope: 'all',
      category: 'purchase_orders',
    },
    {
      resource: 'purchase_orders',
      action: 'delete',
      name: 'purchase_orders.delete',
      scope: 'all',
      category: 'purchase_orders',
    },

    {
      resource: 'reports',
      action: 'view',
      name: 'reports.view',
      scope: 'all',
      category: 'reports',
    },
    {
      resource: 'dashboard',
      action: 'view',
      name: 'dashboard.view',
      scope: 'all',
      category: 'dashboard',
    },
    {
      resource: 'analytics',
      action: 'view',
      name: 'analytics.view',
      scope: 'all',
      category: 'analytics',
    },
    {
      resource: 'price_books',
      action: 'view',
      name: 'price_books.view',
      scope: 'all',
      category: 'price_books',
    },
    {
      resource: 'price_books',
      action: 'create',
      name: 'price_books.create',
      scope: 'all',
      category: 'price_books',
    },
    {
      resource: 'price_books',
      action: 'update',
      name: 'price_books.update',
      scope: 'all',
      category: 'price_books',
    },
    {
      resource: 'price_books',
      action: 'delete',
      name: 'price_books.delete',
      scope: 'all',
      category: 'price_books',
    },
    {
      resource: 'posts',
      action: 'view',
      name: 'posts.view',
      scope: 'all',
      category: 'posts',
    },
    {
      resource: 'posts',
      action: 'create',
      name: 'posts.create',
      scope: 'all',
      category: 'posts',
    },
    {
      resource: 'posts',
      action: 'update',
      name: 'posts.update',
      scope: 'all',
      category: 'posts',
    },
    {
      resource: 'posts',
      action: 'delete',
      name: 'posts.delete',
      scope: 'all',
      category: 'posts',
    },

    {
      resource: 'users',
      action: 'view',
      name: 'users.view',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'users',
      action: 'create',
      name: 'users.create',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'users',
      action: 'update',
      name: 'users.update',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'users',
      action: 'delete',
      name: 'users.delete',
      scope: 'all',
      category: 'admin',
    },

    {
      resource: 'roles',
      action: 'view',
      name: 'roles.view',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'roles',
      action: 'create',
      name: 'roles.create',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'roles',
      action: 'update',
      name: 'roles.update',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'roles',
      action: 'delete',
      name: 'roles.delete',
      scope: 'all',
      category: 'admin',
    },

    {
      resource: 'permissions',
      action: 'view',
      name: 'permissions.view',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'permissions',
      action: 'create',
      name: 'permissions.create',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'permissions',
      action: 'update',
      name: 'permissions.update',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'permissions',
      action: 'delete',
      name: 'permissions.delete',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'permissions',
      action: 'assign',
      name: 'permissions.assign',
      scope: 'all',
      category: 'admin',
    },

    {
      resource: 'branches',
      action: 'view',
      name: 'branches.view',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'branches',
      action: 'create',
      name: 'branches.create',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'branches',
      action: 'update',
      name: 'branches.update',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'branches',
      action: 'delete',
      name: 'branches.delete',
      scope: 'all',
      category: 'admin',
    },

    {
      resource: 'audit-logs',
      action: 'view',
      name: 'audit-logs.view',
      scope: 'all',
      category: 'admin',
    },

    {
      resource: 'print-templates',
      action: 'view',
      name: 'print-templates.view',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'print-templates',
      action: 'create',
      name: 'print-templates.create',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'print-templates',
      action: 'update',
      name: 'print-templates.update',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'print-templates',
      action: 'delete',
      name: 'print-templates.delete',
      scope: 'all',
      category: 'admin',
    },

    {
      resource: 'settings',
      action: 'view',
      name: 'settings.view',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'settings',
      action: 'update',
      name: 'settings.update',
      scope: 'all',
      category: 'admin',
    },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: {
        name: perm.name,
        resource: perm.resource,
        action: perm.action,
        scope: perm.scope,
        category: perm.category,
        description: `Can ${perm.action} ${perm.resource}`,
      },
    });
  }

  const allPermissions = await prisma.permission.findMany();
  for (const perm of allPermissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: adminRole.id,
          permissionId: perm.id,
        },
      },
      update: {},
      create: {
        roleId: adminRole.id,
        permissionId: perm.id,
      },
    });
  }

  const adminUser = await prisma.user.upsert({
    where: { email: 'dieptra.sg@gmail.com' },
    update: {},
    create: {
      name: 'Admin',
      email: 'dieptra.sg@gmail.com',
      password: await bcrypt.hash('Dieptra@123', 10),
      isActive: true,
    },
  });

  await prisma.userRole.upsert({
    where: {
      userId_roleId: {
        userId: adminUser.id,
        roleId: adminRole.id,
      },
    },
    update: {},
    create: {
      userId: adminUser.id,
      roleId: adminRole.id,
    },
  });

  const branch1 = await prisma.branch.upsert({
    where: { id: 1 },
    update: {},
    create: {
      name: 'Kho Sài Gòn',
      contactNumber: '0901234567',
      address: '123 Nguyễn Văn Linh, Q7, TP.HCM',
      isActive: true,
    },
  });

  const branch2 = await prisma.branch.upsert({
    where: { id: 2 },
    update: {},
    create: {
      name: 'Kho Hà Nội',
      contactNumber: '0912345678',
      address: '456 Láng Hạ, Đống Đa, Hà Nội',
      isActive: true,
    },
  });

  const branch3 = await prisma.branch.upsert({
    where: { id: 3 },
    update: {},
    create: {
      name: 'Cửa Hàng Diệp Trà',
      contactNumber: '0923456789',
      address: '789 Lê Lợi, Q1, TP.HCM',
      isActive: true,
    },
  });

  console.log('Seed completed successfully');

  await seedPermissions();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

async function seedPermissions() {
  const permissions = [
    {
      resource: 'products',
      action: 'view',
      name: 'products.view',
      scope: 'all',
      category: 'products',
    },
    {
      resource: 'products',
      action: 'create',
      name: 'products.create',
      scope: 'all',
      category: 'products',
    },
    {
      resource: 'products',
      action: 'update',
      name: 'products.update',
      scope: 'all',
      category: 'products',
    },
    {
      resource: 'products',
      action: 'delete',
      name: 'products.delete',
      scope: 'all',
      category: 'products',
    },
    {
      resource: 'orders',
      action: 'view',
      name: 'orders.view.own',
      scope: 'own',
      category: 'orders',
    },
    {
      resource: 'orders',
      action: 'view',
      name: 'orders.view.branch',
      scope: 'branch',
      category: 'orders',
    },
    {
      resource: 'orders',
      action: 'view',
      name: 'orders.view.all',
      scope: 'all',
      category: 'orders',
    },
    {
      resource: 'orders',
      action: 'create',
      name: 'orders.create',
      scope: 'all',
      category: 'orders',
    },
    {
      resource: 'orders',
      action: 'update',
      name: 'orders.update.own',
      scope: 'own',
      category: 'orders',
    },
    {
      resource: 'orders',
      action: 'update',
      name: 'orders.update.all',
      scope: 'all',
      category: 'orders',
    },
    {
      resource: 'orders',
      action: 'delete',
      name: 'orders.delete',
      scope: 'all',
      category: 'orders',
    },
    {
      resource: 'invoices',
      action: 'view',
      name: 'invoices.view.own',
      scope: 'own',
      category: 'invoices',
    },
    {
      resource: 'invoices',
      action: 'view',
      name: 'invoices.view.all',
      scope: 'all',
      category: 'invoices',
    },
    {
      resource: 'invoices',
      action: 'create',
      name: 'invoices.create',
      scope: 'all',
      category: 'invoices',
    },
    {
      resource: 'customers',
      action: 'view',
      name: 'customers.view.all',
      scope: 'all',
      category: 'customers',
    },
    {
      resource: 'customers',
      action: 'create',
      name: 'customers.create',
      scope: 'all',
      category: 'customers',
    },
    {
      resource: 'reports',
      action: 'view',
      name: 'reports.view',
      scope: 'all',
      category: 'reports',
    },
    {
      resource: 'users',
      action: 'view',
      name: 'users.view',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'roles',
      action: 'view',
      name: 'roles.view',
      scope: 'all',
      category: 'admin',
    },
    {
      resource: 'branches',
      action: 'view',
      name: 'branches.view',
      scope: 'all',
      category: 'admin',
    },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: perm,
    });
  }

  console.log('Permissions seeded');

  const adminRole = await prisma.role.findUnique({
    where: { name: 'Administrator' },
  });
  if (adminRole) {
    const allPermissions = await prisma.permission.findMany();
    for (const perm of allPermissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: adminRole.id,
            permissionId: perm.id,
          },
        },
        update: {},
        create: {
          roleId: adminRole.id,
          permissionId: perm.id,
        },
      });
    }
    console.log('Admin role permissions assigned');
  }
}
