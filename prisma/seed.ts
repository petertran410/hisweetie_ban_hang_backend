import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const adminRole = await prisma.role.upsert({
    update: {},
    create: {
      name: 'Administrator',
      description: 'Full system access',
    },
  });

  const permissions = [
    { resource: 'products', action: 'view' },
    { resource: 'products', action: 'create' },
    { resource: 'products', action: 'update' },
    { resource: 'products', action: 'delete' },
    { resource: 'orders', action: 'view' },
    { resource: 'orders', action: 'create' },
    { resource: 'orders', action: 'update' },
    { resource: 'orders', action: 'delete' },
    { resource: 'customers', action: 'view' },
    { resource: 'customers', action: 'create' },
    { resource: 'customers', action: 'update' },
    { resource: 'customers', action: 'delete' },
    { resource: 'reports', action: 'view' },
    { resource: 'users', action: 'manage' },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: {
        resource_action: { resource: perm.resource, action: perm.action },
      },
      update: {},
      create: {
        name: `${perm.resource}.${perm.action}`,
        resource: perm.resource,
        action: perm.action,
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

  console.log('Seed completed successfully');

  const additionalPermissions = [
    { resource: 'roles', action: 'view' },
    { resource: 'roles', action: 'create' },
    { resource: 'roles', action: 'update' },
    { resource: 'roles', action: 'delete' },
    { resource: 'permissions', action: 'view' },
    { resource: 'permissions', action: 'create' },
    { resource: 'permissions', action: 'update' },
    { resource: 'permissions', action: 'delete' },
    { resource: 'suppliers', action: 'view' },
    { resource: 'suppliers', action: 'create' },
    { resource: 'suppliers', action: 'update' },
    { resource: 'suppliers', action: 'delete' },
    { resource: 'purchase_orders', action: 'view' },
    { resource: 'purchase_orders', action: 'create' },
    { resource: 'purchase_orders', action: 'update' },
    { resource: 'purchase_orders', action: 'delete' },
    { resource: 'posts', action: 'view' },
    { resource: 'posts', action: 'create' },
    { resource: 'posts', action: 'update' },
    { resource: 'posts', action: 'delete' },
    { resource: 'dashboard', action: 'view' },
    { resource: 'analytics', action: 'view' },
  ];

  for (const perm of additionalPermissions) {
    await prisma.permission.upsert({
      where: {
        resource_action: { resource: perm.resource, action: perm.action },
      },
      update: {},
      create: {
        name: `${perm.resource}.${perm.action}`,
        resource: perm.resource,
        action: perm.action,
        description: `Can ${perm.action} ${perm.resource}`,
      },
    });
  }

  const allNewPermissions = await prisma.permission.findMany();
  for (const perm of allNewPermissions) {
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
