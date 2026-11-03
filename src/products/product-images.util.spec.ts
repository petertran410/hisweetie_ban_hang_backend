import { buildProductImageRows } from './product-images.util';

const primaryOf = (rows: { image: string; isPrimary: boolean }[]) =>
  rows.filter((r) => r.isPrimary).map((r) => r.image);

describe('buildProductImageRows', () => {
  it('đánh dấu ảnh client chọn', () => {
    const rows = buildProductImageRows(1, ['a', 'b', 'c'], 'b');
    expect(primaryOf(rows)).toEqual(['b']);
    expect(rows.map((r) => r.image)).toEqual(['a', 'b', 'c']);
    expect(rows.every((r) => r.productId === 1)).toBe(true);
  });

  it('không chọn → giữ ảnh chính cũ nếu còn trong danh sách', () => {
    expect(primaryOf(buildProductImageRows(1, ['a', 'b'], undefined, 'b'))).toEqual(['b']);
  });

  it('ảnh chọn đã bị xoá → lấy ứng viên tiếp theo rồi tới ảnh đầu', () => {
    expect(primaryOf(buildProductImageRows(1, ['a', 'b'], 'x', 'b'))).toEqual(['b']);
    expect(primaryOf(buildProductImageRows(1, ['a', 'b'], 'x', 'y'))).toEqual(['a']);
    expect(primaryOf(buildProductImageRows(1, ['a', 'b']))).toEqual(['a']);
  });

  it('URL lặp chỉ đánh dấu 1 lần', () => {
    const rows = buildProductImageRows(1, ['a', 'b', 'b'], 'b');
    expect(rows.map((r) => r.isPrimary)).toEqual([false, true, false]);
  });

  it('danh sách rỗng → không có dòng nào', () => {
    expect(buildProductImageRows(1, [], 'a')).toEqual([]);
  });
});
