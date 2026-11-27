import {
  buildGroupReply,
  buildGroupRootCard,
  buildReminderCard,
  buildTicketCard,
  changeText,
} from './price-change-lark-cards';

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

  it('từ chối có người, vai trò, lý do', () => {
    const built = buildTicketCard('REJECTED', ticket, {
      link: 'l',
      reason: 'Giá chưa hợp lý',
      decidedByName: 'Anh B',
      decidedByRole: 'CEO',
    });
    const text = JSON.stringify(built.card);
    expect(text).toContain('Anh B (CEO)');
    expect(text).toContain('Giá chưa hợp lý');
    expect(built.body.startsWith('TDG')).toBe(true);
  });
});

describe('nhóm Lark dạng topic', () => {
  it('tin mở đầu topic có mã phiếu, danh sách sản phẩm, nút xem phiếu', () => {
    const text = JSON.stringify(buildGroupRootCard(ticket, 'http://pos/v'));
    expect(text).toContain('Đề xuất thay đổi giá TDG000001');
    expect(text).toContain('SP1');
    expect(text).toContain('http://pos/v');
  });

  it('tin trả lời là post: tiêu đề, hàng tag đầu, dòng đề nghị, link mở phiếu', () => {
    const post = buildGroupReply('TO_CEO', {
      link: 'http://pos/x&open=1',
      mentions: [
        { name: 'CEO', openId: 'ou_c' },
        { name: 'Chưa Lark', openId: null },
      ],
      decidedByName: 'Chị KTT',
      decidedByRole: 'Kế toán trưởng',
    });
    const { title, content } = post.zh_cn;
    expect(title).toBe('CEO duyệt thay đổi giá vốn');
    expect(content[0]).toEqual([
      { tag: 'at', user_id: 'ou_c', user_name: 'CEO' },
      { tag: 'text', text: ' ' },
      { tag: 'text', text: 'Chưa Lark', style: ['bold'] },
    ]);
    expect(content[1]).toEqual([
      { tag: 'text', text: 'Chị KTT', style: ['bold'] },
      { tag: 'text', text: ' (Kế toán trưởng) đã duyệt.' },
    ]);
    expect(content[2]).toEqual([
      { tag: 'text', text: 'Đề nghị CEO duyệt thay đổi giá vốn.' },
    ]);
    expect(content[3]).toEqual([
      { tag: 'a', text: 'Mở phiếu để xử lý', href: 'http://pos/x&open=1' },
    ]);
  });

  it('gửi lại sau khi bị trả về ghi rõ', () => {
    const text = JSON.stringify(
      buildGroupReply('TO_KTT', {
        link: 'l',
        mentions: [{ name: 'KTT', openId: 'ou_k' }],
        resubmit: true,
        decidedByName: 'NV',
        decidedByRole: 'Người đề xuất',
      }),
    );
    expect(text).toContain('đã sửa và gửi lại phiếu');
    expect(text).toContain('"user_id":"ou_k"');
  });

  it('từ chối có lý do, tag người đề xuất, link chỉ để xem', () => {
    const post = buildGroupReply('REJECTED', {
      link: 'l',
      mentions: [{ name: 'NV', openId: 'ou_p' }],
      decidedByName: 'Anh CEO',
      decidedByRole: 'CEO',
      reason: 'Giá thấp',
    });
    const text = JSON.stringify(post);
    expect(text).toContain('Giá thấp');
    expect(text).toContain('Đề nghị người đề xuất kiểm tra');
    expect(post.zh_cn.content.at(-1)).toEqual([
      { tag: 'a', text: 'Xem phiếu', href: 'l' },
    ]);
  });

  it('chưa cấu hình người nhận thì ghi rõ thay cho hàng tag', () => {
    const post = buildGroupReply('TO_DATA', { link: 'l', mentions: [] });
    expect(JSON.stringify(post.zh_cn.content[0])).toContain('chưa cấu hình');
  });
});

describe('nhắc việc hằng ngày', () => {
  const item = (i: number) => ({
    code: `TDG${String(i).padStart(6, '0')}`,
    hasCost: true,
    hasSale: i % 2 === 0,
    itemCount: i === 1 ? 3 : 1,
    firstProduct: `SP${i} Sản phẩm ${i}`,
    days: i,
  });

  it('1 tin tổng hợp: bước, số phiếu, từng phiếu kèm số ngày chờ, nút xem danh sách', () => {
    const built = buildReminderCard(
      'Kế toán trưởng',
      [item(1), item(2)],
      'http://pos/thay-doi-gia?stage=CHIEF_ACCOUNTANT',
      ['Chị KTT'],
    );
    const text = JSON.stringify(built.card);
    expect(built.body).toBe(
      '2 phiếu thay đổi giá đang chờ xử lý tại Kế toán trưởng',
    );
    expect(text).toContain('Gửi Chị KTT');
    expect(text).toContain(
      '**TDG000001** – Giá vốn · SP1 Sản phẩm 1 +2 SP (1 ngày)',
    );
    expect(text).toContain(
      '**TDG000002** – Giá vốn + Giá bán · SP2 Sản phẩm 2 (2 ngày)',
    );
    expect(text).toContain('http://pos/thay-doi-gia?stage=CHIEF_ACCOUNTANT');
  });

  it('quá 20 phiếu thì ghi "… và N phiếu khác"', () => {
    const items = Array.from({ length: 23 }, (_, i) => item(i + 1));
    const text = JSON.stringify(buildReminderCard('CEO', items, 'l').card);
    expect(text).toContain('TDG000020');
    expect(text).not.toContain('TDG000021');
    expect(text).toContain('… và 3 phiếu khác');
  });
});
