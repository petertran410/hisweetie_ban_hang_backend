// prisma/seed.ts - Replace toàn bộ file
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Create admin role
  const adminRole = await prisma.role.upsert({
    where: { name: 'Administrator' },
    update: {},
    create: {
      name: 'Administrator',
      description: 'Full system access',
    },
  });

  // Create user role
  const userRole = await prisma.role.upsert({
    where: { name: 'User' },
    update: {},
    create: {
      name: 'User',
      description: 'Basic user access',
    },
  });

  // Create permissions
  const permissions = [
    { resource: 'products', action: 'view', name: 'products.view' },
    { resource: 'products', action: 'create', name: 'products.create' },
    { resource: 'products', action: 'update', name: 'products.update' },
    { resource: 'products', action: 'delete', name: 'products.delete' },
    { resource: 'orders', action: 'view', name: 'orders.view' },
    { resource: 'orders', action: 'create', name: 'orders.create' },
    { resource: 'orders', action: 'update', name: 'orders.update' },
    { resource: 'orders', action: 'delete', name: 'orders.delete' },
    { resource: 'customers', action: 'view', name: 'customers.view' },
    { resource: 'customers', action: 'create', name: 'customers.create' },
    { resource: 'customers', action: 'update', name: 'customers.update' },
    { resource: 'customers', action: 'delete', name: 'customers.delete' },
    { resource: 'reports', action: 'view', name: 'reports.view' },
    { resource: 'users', action: 'manage', name: 'users.manage' },
    { resource: 'roles', action: 'view', name: 'roles.view' },
    { resource: 'roles', action: 'create', name: 'roles.create' },
    { resource: 'roles', action: 'update', name: 'roles.update' },
    { resource: 'roles', action: 'delete', name: 'roles.delete' },
    { resource: 'permissions', action: 'view', name: 'permissions.view' },
    { resource: 'permissions', action: 'create', name: 'permissions.create' },
    { resource: 'permissions', action: 'update', name: 'permissions.update' },
    { resource: 'permissions', action: 'delete', name: 'permissions.delete' },
    { resource: 'suppliers', action: 'view', name: 'suppliers.view' },
    { resource: 'suppliers', action: 'create', name: 'suppliers.create' },
    { resource: 'suppliers', action: 'update', name: 'suppliers.update' },
    { resource: 'suppliers', action: 'delete', name: 'suppliers.delete' },
    {
      resource: 'purchase_orders',
      action: 'view',
      name: 'purchase_orders.view',
    },
    {
      resource: 'purchase_orders',
      action: 'create',
      name: 'purchase_orders.create',
    },
    {
      resource: 'purchase_orders',
      action: 'update',
      name: 'purchase_orders.update',
    },
    {
      resource: 'purchase_orders',
      action: 'delete',
      name: 'purchase_orders.delete',
    },
    { resource: 'posts', action: 'view', name: 'posts.view' },
    { resource: 'posts', action: 'create', name: 'posts.create' },
    { resource: 'posts', action: 'update', name: 'posts.update' },
    { resource: 'posts', action: 'delete', name: 'posts.delete' },
    { resource: 'dashboard', action: 'view', name: 'dashboard.view' },
    { resource: 'analytics', action: 'view', name: 'analytics.view' },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: {
        resource_action: { resource: perm.resource, action: perm.action },
      },
      update: {},
      create: {
        name: perm.name,
        resource: perm.resource,
        action: perm.action,
        description: `Can ${perm.action} ${perm.resource}`,
      },
    });
  }

  // Assign all permissions to admin role
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

  // Create admin user
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

  // Assign admin role to admin user
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

  // Create branches
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
  console.log('Admin user:', adminUser);
  console.log('Branches:', { branch1, branch2, branch3 });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
