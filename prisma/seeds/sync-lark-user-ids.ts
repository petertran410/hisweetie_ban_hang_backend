/**
 * Sync Lark user open_ids vào cột `User.larkUserId`.
 *
 * Pipeline:
 * 1. Gọi Lark contact API: scope.list → list department + loose users của bot
 * 2. Mỗi department: contact.user.findByDepartment → user list
 * 3. Match theo tên (lowercase + trim, giữ dấu tiếng Việt) với User.name trong DB
 * 4. Update larkUserId tương ứng (skip nếu đã trùng giá trị)
 *
 * Cách chạy:
 *   yarn sync:lark-users
 *
 * Env required: LARK_APP_ID, LARK_APP_SECRET, DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client';
import * as lark from '@larksuiteoapi/node-sdk';
import * as dotenv from 'dotenv';
import { join } from 'path';

dotenv.config({ path: join(process.cwd(), '.env') });

const prisma = new PrismaClient();

interface LarkUser {
  open_id: string;
  name: string;
  en_name?: string;
  email?: string;
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
}

async function fetchLarkUsers(): Promise<LarkUser[]> {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('LARK_APP_ID / LARK_APP_SECRET phải được cấu hình');
  }

  const client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
  });

  // 1. Lấy scope: department list + loose user list
  const departmentIds: string[] = [];
  const looseUserIds: string[] = [];
  let pageToken: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res: any = await client.contact.scope.list({
      params: {
        user_id_type: 'open_id',
        department_id_type: 'open_department_id',
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res?.code && res.code !== 0) {
      throw new Error(`scope.list code=${res.code} msg=${res.msg}`);
    }
    departmentIds.push(...(res?.data?.department_ids || []));
    looseUserIds.push(...(res?.data?.user_ids || []));
    if (!res?.data?.has_more) break;
    pageToken = res?.data?.page_token;
  }
  console.log(
    `[scope] depts=${departmentIds.length} loose_users=${looseUserIds.length}`,
  );

  const seen = new Set<string>();
  const users: LarkUser[] = [];

  // 2. Mỗi department → list users
  for (const dept of departmentIds) {
    let pt: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res: any = await client.contact.user.findByDepartment({
        params: {
          user_id_type: 'open_id',
          department_id_type: 'open_department_id',
          department_id: dept,
          page_size: 50,
          ...(pt ? { page_token: pt } : {}),
        },
      });
      if (res?.code && res.code !== 0) {
        console.warn(
          `findByDepartment dept=${dept} code=${res.code} msg=${res.msg} — bỏ qua`,
        );
        break;
      }
      const items = res?.data?.items || [];
      for (const u of items) {
        if (u?.open_id && !seen.has(u.open_id)) {
          seen.add(u.open_id);
          users.push({
            open_id: u.open_id,
            name: u.name,
            en_name: u.en_name,
            email: u.email,
          });
        }
      }
      if (!res?.data?.has_more) break;
      pt = res?.data?.page_token;
    }
  }

  // 3. Loose users
  for (const openId of looseUserIds) {
    if (seen.has(openId)) continue;
    try {
      const res: any = await client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      if (res?.code === 0 && res?.data?.user) {
        seen.add(openId);
        users.push({
          open_id: res.data.user.open_id,
          name: res.data.user.name,
          en_name: res.data.user.en_name,
          email: res.data.user.email,
        });
      }
    } catch (err: any) {
      console.warn(`contact.user.get ${openId} lỗi: ${err.message}`);
    }
  }

  return users;
}

async function main() {
  console.log('Pulling Lark users via contact API...');
  const larkUsers = await fetchLarkUsers();
  console.log(`Fetched ${larkUsers.length} Lark users`);

  // Map normalized-name → larkUser (giữ user đầu nếu trùng tên)
  const byName = new Map<string, LarkUser>();
  const byEmail = new Map<string, LarkUser>();
  for (const u of larkUsers) {
    if (u.name) {
      const k = normalize(u.name);
      if (k && !byName.has(k)) byName.set(k, u);
    }
    if (u.en_name) {
      const k = normalize(u.en_name);
      if (k && !byName.has(k)) byName.set(k, u);
    }
    if (u.email) {
      const k = u.email.trim().toLowerCase();
      if (k) byEmail.set(k, u);
    }
  }

  const dbUsers = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, email: true, larkUserId: true },
  });
  console.log(`Active DB users: ${dbUsers.length}`);

  let matched = 0;
  let skippedSame = 0;
  let unmatched: { id: number; name: string }[] = [];
  let conflicts: string[] = [];

  for (const u of dbUsers) {
    const byEmailHit = u.email
      ? byEmail.get(u.email.trim().toLowerCase())
      : null;
    const byNameHit = byName.get(normalize(u.name));
    const hit = byEmailHit || byNameHit;

    if (!hit) {
      unmatched.push({ id: u.id, name: u.name });
      continue;
    }

    if (u.larkUserId === hit.open_id) {
      skippedSame++;
      continue;
    }

    try {
      await prisma.user.update({
        where: { id: u.id },
        data: { larkUserId: hit.open_id },
      });
      matched++;
      console.log(
        `  ✓ ${u.name} (#${u.id}) → ${hit.open_id} (lark name="${hit.name}")`,
      );
    } catch (err: any) {
      // Prisma P2002 = unique constraint
      conflicts.push(
        `User #${u.id} "${u.name}": ${err.code || ''} ${err.message}`,
      );
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Updated:        ${matched}`);
  console.log(`Already in sync: ${skippedSame}`);
  console.log(`Unmatched:      ${unmatched.length}`);
  console.log(`Conflicts:      ${conflicts.length}`);

  if (unmatched.length > 0) {
    console.log(`\nUnmatched DB users (cần đổi tên hoặc gán tay):`);
    for (const u of unmatched) {
      console.log(`  - #${u.id} ${u.name}`);
    }
  }
  if (conflicts.length > 0) {
    console.log(`\nConflicts:`);
    for (const c of conflicts) console.log(`  - ${c}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
