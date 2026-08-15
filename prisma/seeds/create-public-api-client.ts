/**
 * Tạo/luân chuyển credential cho một Public API client (OAuth client-credentials).
 *
 * KHÔNG xóa dữ liệu, KHÔNG reset DB — chỉ upsert đúng 1 bản ghi public_api_clients.
 *
 * Cách dùng:
 *   npx ts-node prisma/seeds/create-public-api-client.ts "Zalo CRM"
 *
 * In ra client_id + client_secret MỘT LẦN DUY NHẤT (secret chỉ lưu dạng hash).
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Thiếu tham số: tên client. Ví dụ: ts-node prisma/seeds/create-public-api-client.ts "Zalo CRM"');
    process.exit(1);
  }

  const clientId = `hpa_${randomUUID().replace(/-/g, '')}`;
  const clientSecret = randomBytes(32).toString('base64url');
  const hashed = await bcrypt.hash(clientSecret, 10);

  const client = await prisma.publicApiClient.create({
    data: { name, clientId, clientSecret: hashed, isActive: true },
    select: { id: true, name: true, clientId: true, accessTokenTtl: true },
  });

  console.log('Đã tạo Public API client:');
  console.log(JSON.stringify({ ...client, clientSecret }, null, 2));
  console.log('\nLƯU NGAY clientSecret — hệ thống chỉ lưu bản hash, không thể xem lại.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
