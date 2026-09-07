import { createHash } from 'crypto';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { patchShippingFeeTemplate } from '../../src/print-templates/shipping-fee-template-patch';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const targets = [
  { templateFor: 'invoice' as const, code: 'invoice1_A4' },
  { templateFor: 'order' as const, code: 'order_A5' },
  { templateFor: 'consignment' as const, code: 'KG_DEFAULT' },
];

const hash = (content: string) =>
  createHash('sha256').update(content).digest('hex').slice(0, 12);

async function main() {
  const templates = await prisma.printTemplate.findMany({
    where: { OR: targets },
  });

  if (templates.length !== targets.length) {
    const found = new Set(templates.map((template) => template.code));
    const missing = targets
      .filter((target) => !found.has(target.code))
      .map((target) => `${target.templateFor}/${target.code}`);
    throw new Error(`Không tìm thấy mẫu in: ${missing.join(', ')}`);
  }

  const changes = templates.map((template) => {
    const content = patchShippingFeeTemplate(
      template.templateFor as 'invoice' | 'order' | 'consignment',
      template.content,
    );
    return {
      template,
      content,
      changed: content !== template.content,
    };
  });

  for (const change of changes) {
    console.log(
      `${change.template.templateFor}/${change.template.code}: ${change.changed ? `${hash(change.template.content)} -> ${hash(change.content)}` : 'đã có phí ship'}`,
    );
  }

  if (!apply) {
    console.log('Dry run hoàn tất. Chạy lại với --apply để cập nhật DB.');
    return;
  }

  const backupPath = join(
    tmpdir(),
    `print-templates-before-shipping-fee-${Date.now()}.json`,
  );
  await writeFile(
    backupPath,
    JSON.stringify(
      changes.map(({ template }) => ({
        id: template.id,
        templateFor: template.templateFor,
        code: template.code,
        content: template.content,
      })),
      null,
      2,
    ),
  );

  await prisma.$transaction(
    changes
      .filter((change) => change.changed)
      .map((change) =>
        prisma.printTemplate.update({
          where: { id: change.template.id },
          data: { content: change.content },
        }),
      ),
  );

  console.log(`Đã cập nhật mẫu in. Backup: ${backupPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
