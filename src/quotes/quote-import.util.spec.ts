import {
  cleanGreeting,
  cleanSpec,
  matchProduct,
  parseAppliedDate,
  tierFromHeader,
} from './quote-import.util';

const products = [
  {
    id: 1,
    name: "Gấu Lermao - Khoai Môn Tím Nghiền Đông Lạnh 500gr - Nấu 10' (BẢO QUẢN TỦ ĐÔNG) (40 Túi/Thùng)",
  },
  {
    id: 2,
    name: "Gấu Lermao - Khoai Môn Nghiền 500gr - Nấu 10' (BẢO QUẢN TỦ ĐÔNG) (40 Túi/Thùng)",
  },
  { id: 3, name: 'Gấu Lermao - Bột Kem Trứng Vàng 1kg (25 túi/ thùng)' },
  { id: 4, name: 'Mẫu Thử 100gr - Gấu Lermao - Mứt Xoài Xanh' },
  { id: 5, name: 'Gấu Lermao - Mứt Xoài Xanh 1kg (12 Túi/Thùng)' },
];

describe('matchProduct — khớp tên Excel với sản phẩm POS', () => {
  it('khớp đúng sản phẩm, ưu tiên tên ít từ thừa (nghiền thường vs nghiền tím)', () => {
    expect(matchProduct('Khoai môn nghiền đông lạnh 500gr', products)?.id).toBe(
      2,
    );
    expect(
      matchProduct('Khoai môn tím nghiền đông lạnh 500gr', products)?.id,
    ).toBe(1);
  });

  it('bỏ qua sản phẩm "Mẫu thử"', () => {
    expect(matchProduct('Mứt Xoài Xanh 1kg', products)?.id).toBe(5);
  });

  it('không đủ giống (Kem Trứng Trắng ≠ Kem Trứng Vàng) → null', () => {
    expect(matchProduct('Bột Kem Trứng Trắng 1kg', products)).toBeNull();
  });
});

describe('đọc file báo giá', () => {
  it('tiêu đề cột giá → khung giá', () => {
    expect(tierFromHeader('Giá lẻ\n(Đã bao gồm VAT)')?.key).toBe('le');
    expect(tierFromHeader('Giá CTV\n(Đã bao gồm VAT)')?.key).toBe('ctv');
    expect(tierFromHeader('Giá Đại Lý < 10T \n(Đã bao gồm VAT)')).toMatchObject(
      { key: 'dl_lt10', minQty: 1, maxQty: 9 },
    );
    expect(
      tierFromHeader('Giá Đại Lý >= 10T \n(Đã bao gồm VAT)'),
    ).toMatchObject({ key: 'dl_ge10', minQty: 10 });
    expect(tierFromHeader('Giá buôn\n(Đã bao gồm VAT)')?.key).toBe('buon');
    expect(tierFromHeader('Lợi Nhuận')).toBeNull();
  });

  it('quy cách, lời chào, ngày áp dụng', () => {
    expect(cleanSpec('(30 túi/thùng)')).toBe('30 túi/thùng');
    expect(cleanGreeting('Kính gủi: Quý Đại lý')).toBe('Quý Đại lý');
    expect(cleanGreeting('Kính gửi: Quý khách hàng')).toBe('Quý khách hàng');
    expect(
      parseAppliedDate('(Áp dụng cho khách hàng từ ngày 01/09/2026)'),
    ).toBe('2026-09-01');
    expect(parseAppliedDate('(Áp dụng từ ngày 01 tháng 09 năm 2026)')).toBe(
      '2026-09-01',
    );
  });
});
