import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const adminRole = await prisma.role.upsert({
    where: { slug: 'admin' },
    update: {},
    create: {
      name: 'Administrator',
      slug: 'admin',
      description: 'Full system access',
    },
  });

  const managerRole = await prisma.role.upsert({
    where: { slug: 'manager' },
    update: {},
    create: {
      name: 'Manager',
      slug: 'manager',
      description: 'Manage products and orders',
    },
  });

  const userRole = await prisma.role.upsert({
    where: { slug: 'user' },
    update: {},
    create: {
      name: 'User',
      slug: 'user',
      description: 'Basic user access',
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
        slug: `${perm.resource}.${perm.action}`,
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
    where: { email: 'admin@hisweetie.com' },
    update: {},
    create: {
      name: 'Admin',
      email: 'admin@hisweetie.com',
      password: await bcrypt.hash('admin123', 10),
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
