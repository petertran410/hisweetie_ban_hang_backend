import { BadRequestException } from '@nestjs/common';
import {
  normalizeUnitKey,
  resolveUnitFromMap,
  resolveUnitName,
} from './unit.util';

const map = new Map([
  ['thùng', 'Thùng'],
  ['kg', 'Kg'],
  ['gói', 'Gói'],
]);

describe('normalizeUnitKey', () => {
  it('bỏ qua hoa/thường, khoảng trắng thừa và dấu gõ tách rời', () => {
    expect(normalizeUnitKey('  THÙNG ')).toBe('thùng');
    // "u" + dấu huyền rời (NFD) → cùng khóa với "ù" (NFC)
    expect(normalizeUnitKey('thùng')).toBe('thùng');
    expect(normalizeUnitKey('hộp   giấy')).toBe('hộp giấy');
  });
});

describe('resolveUnitFromMap', () => {
  it('trả tên chuẩn trong danh mục', () => {
    expect(resolveUnitFromMap(map, 'thùng')).toEqual({ name: 'Thùng' });
    expect(resolveUnitFromMap(map, 'kg')).toEqual({ name: 'Kg' });
  });

  it('không gửi → không đụng tới; rỗng → bỏ trống', () => {
    expect(resolveUnitFromMap(map, undefined)).toEqual({ name: undefined });
    expect(resolveUnitFromMap(map, '   ')).toEqual({ name: '' });
  });

  it('đơn vị lạ → trả về để báo lỗi', () => {
    expect(resolveUnitFromMap(map, ' Thung ')).toEqual({
      name: undefined,
      unknown: 'Thung',
    });
  });
});

describe('resolveUnitName', () => {
  const db = {
    unit: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ name: 'Thùng' }, { name: 'Gói' }]),
    },
  };

  it('quy về tên chuẩn', async () => {
    await expect(resolveUnitName(db, 'GÓI')).resolves.toBe('Gói');
  });

  it('đơn vị lạ → lỗi 400', async () => {
    await expect(resolveUnitName(db, 'Hũ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
