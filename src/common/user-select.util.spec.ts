import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { stripUserSecrets, USER_PUBLIC_SELECT } from './user-select.util';

const ROOT = join(__dirname, '..', '..');

/** Tên quan hệ trỏ tới `User` (và không trùng tên với trường kiểu khác ở model khác). */
function userRelationNames(): string[] {
  const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
  const toUser = new Set<string>();
  const other = new Set<string>();
  for (const line of schema.split('\n')) {
    const m = line.match(
      /^\s+([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)(\?|\[\])?(\s|$)/,
    );
    if (!m || m[1] === 'model') continue;
    (m[2] === 'User' ? toUser : other).add(m[1]);
  }
  return [...toUser].filter((name) => !other.has(name));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('user-select.util', () => {
  it('chỉ trả các trường công khai, không có mật khẩu', () => {
    expect(Object.keys(USER_PUBLIC_SELECT)).not.toContain('password');
    expect(USER_PUBLIC_SELECT).toEqual({
      id: true,
      name: true,
      email: true,
      phone: true,
    });
  });

  it('stripUserSecrets bỏ mật khẩu, giữ phần còn lại', () => {
    const safe = stripUserSecrets({ id: 1, name: 'A', password: 'hash' });
    expect(safe).toEqual({ id: 1, name: 'A' });
    expect('password' in safe).toBe(false);
  });

  it('không nơi nào tải nguyên dòng User qua quan hệ (vd `soldBy: true`)', () => {
    const names = userRelationNames();
    expect(names).toEqual(expect.arrayContaining(['soldBy', 'creator']));
    const pattern = new RegExp(`\\b(${names.join('|')}): true\\b`);
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('*') || code.startsWith('//')) return;
          if (pattern.test(line))
            offenders.push(
              `${file.replace(ROOT + '/', '')}:${i + 1}: ${line.trim()}`,
            );
        });
    }
    expect(offenders).toEqual([]);
  });
});
