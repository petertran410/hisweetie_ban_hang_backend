import { fieldOf } from '../new-product-price/new-product-price-lark-mapping';
import {
  extractLarkChanges,
  inferStage,
  larkCeoDecision,
  matchByName,
  matchPriceBook,
} from './price-change-lark-mapping';

describe('price-change Lark mapping', () => {
  it('đọc cột giá vốn / bảng giá "Muốn Đổi" có giá trị', () => {
    const r = extractLarkChanges({
      'Giá Vốn (Kho Hà Nội) Muốn Đổi': 110000,
      'Giá Vốn (Kho Hà Nội)': [{ text: '100000' }],
      'Giá Vốn (Cửa Hàng Diệp Trà) Muốn Đổi': null,
      'Bảng Giá Chung Muốn Đổi': 162000,
      'Bảng Giá Đỗ Mình Tân 8% Muốn Đổi': '150,000',
      'Ghi chú': 'x',
    });
    expect(r.costs).toEqual([{ name: 'Kho Hà Nội', value: 110000 }]);
    expect(r.prices).toEqual([
      { name: 'Bảng Giá Chung', value: 162000 },
      { name: 'Bảng Giá Đỗ Mình Tân 8%', value: 150000 },
    ]);
  });

  it('khớp chi nhánh / bảng giá không phân biệt dấu, Bảng Giá Chung = 0', () => {
    const branches = [
      { id: 6, name: 'Kho Hà Nội' },
      { id: 4, name: 'Văn phòng Hà Nội' },
      { id: 1, name: 'Kho Sài Gòn' },
    ];
    expect(matchByName('Văn Phòng Hà Nội', branches)?.id).toBe(4);
    expect(matchByName('Cửa Hàng Diệp Trà', branches)).toBeNull();
    const books = [
      { id: 3, name: 'BẢNG GIÁ BUÔN HN' },
      { id: 9, name: 'Bảng Giá Đỗ Minh Tân 8%' },
      { id: 10, name: 'Bảng Giá Đỗ Minh Tân' },
    ];
    expect(matchPriceBook('Bảng Giá Chung', books)).toBe(0);
    expect(matchPriceBook('Bảng Giá Buôn HN', books)).toBe(3);
    // "Mình" gõ sai dấu vẫn khớp; tên ngắn khớp đúng bản ghi bằng nhau
    expect(matchPriceBook('Bảng Giá Đỗ Mình Tân 8%', books)).toBe(9);
    expect(matchPriceBook('Bảng Giá Đỗ Minh Tân', books)).toBe(10);
  });

  it('suy bước từ quyết định (Flow hầu như không được chuyển)', () => {
    const base = {
      flow: 'Đề xuất giá vốn',
      hasCost: true,
      ktt: null,
      ceo: null,
    };
    expect(inferStage(base)).toBe('PROPOSAL');
    expect(inferStage({ ...base, ktt: 'APPROVED' })).toBe('CEO');
    expect(inferStage({ ...base, hasCost: false, ktt: 'APPROVED' })).toBe(
      'DATA',
    );
    expect(inferStage({ ...base, ceo: 'APPROVED' })).toBe('DONE');
    expect(inferStage({ ...base, ktt: 'REJECTED' })).toBe('ENDED');
    expect(inferStage({ ...base, flow: 'Kế toán trưởng duyệt' })).toBe(
      'CHIEF_ACCOUNTANT',
    );
    expect(inferStage({ ...base, flow: 'Done' })).toBe('DONE');
  });

  it('CEO: phiếu giá vốn đọc "CEO Duyệt Giá Vốn", thiếu thì lấy giá bán', () => {
    const f = { 'CEO Duyệt Giá Bán': 'Approved' };
    expect(larkCeoDecision(f, true, fieldOf)).toBe('APPROVED');
    expect(
      larkCeoDecision(
        { 'CEO Duyệt Giá Vốn': 'Rejected', 'CEO Duyệt Giá Bán': 'Approved' },
        true,
        fieldOf,
      ),
    ).toBe('REJECTED');
    expect(larkCeoDecision({}, false, fieldOf)).toBeNull();
  });
});
