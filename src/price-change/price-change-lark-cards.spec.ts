import { buildTicketCard, changeText } from './price-change-lark-cards';

const ticket = {
  code: 'TDG000001',
  createdByName: 'Admin',
  createdAt: new Date('2026-11-27T03:00:00Z'),
  note: null,
  hasCost: true,
  hasSale: true,
  items: Array.from({ length: 12 }, (_, i) => ({
    productCode: `SP${i + 1}`,
    productName: `Sản phẩm ${i + 1}`,
    costs: [
      {
        branchId: 6,
        branchName: 'Kho Hà Nội',
        oldCost: 100000,
        newCost: 110000,
      },
      {
        branchId: 1,
        branchName: 'Kho Sài Gòn',
        oldCost: 100000,
        newCost: null,
      },
    ],
    prices: [
      {
        priceBookId: 0,
        priceBookName: 'Bảng giá chung',
        oldPrice: 200000,
        newPrice: 180000,
      },
    ],
  })),
};

describe('price-change Lark cards', () => {
  it('chênh lệch kiểu en-US kèm mũi tên và %', () => {
    expect(changeText(100000, 110000)).toBe('100,000 → 110,000 (⬆️ +10%)');
    expect(changeText(200000, 180000)).toBe('200,000 → 180,000 (⬇️ -10%)');
    expect(changeText(null, 50000)).toBe('→ 50,000');
  });

  it('card Kế toán trưởng liệt kê tối đa 10 sản phẩm, chỉ ô có giá mới', () => {
    const built = buildTicketCard('TO_KTT', ticket, {
      link: 'http://pos/x',
      greetingNames: ['Chị A'],
    });
    const text = JSON.stringify(built.card);
    expect(built.title).toBe('Kế toán trưởng duyệt thay đổi giá');
    expect(text).toContain('Gửi Chị A');
    expect(text).toContain('Giá vốn + Giá bán · 12 sản phẩm');
    expect(text).toContain('Giá vốn Kho Hà Nội: 100,000 → 110,000');
    expect(text).not.toContain('Kho Sài Gòn');
    expect(text).toContain('SP10');
    expect(text).not.toContain('**SP11**');
    expect(text).toContain('… và 2 sản phẩm khác');
    expect(text).toContain('http://pos/x');
  });

  it('từ chối có người, vai trò, lý do; gửi thử có ghi chú đầu tin', () => {
    const built = buildTicketCard('REJECTED', ticket, {
      link: 'l',
      reason: 'Giá chưa hợp lý',
      decidedByName: 'Anh B',
      decidedByRole: 'CEO',
      testNote: '🧪 GỬI THỬ',
    });
    const text = JSON.stringify(built.card);
    expect(text).toContain('Anh B (CEO)');
    expect(text).toContain('Giá chưa hợp lý');
    expect(text).toContain('🧪 GỬI THỬ');
    expect(built.body.startsWith('[Gửi thử]')).toBe(true);
  });
});
