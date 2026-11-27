import {
  buildReminderCard,
  buildTicketCard,
  CardTicket,
} from './new-product-price-lark-cards';

const ticket: CardTicket = {
  code: 'SPM000123',
  productName: 'Siro Đào 750ml',
  parentName: 'Hàng thương hiệu',
  childName: 'Siro',
  tradeMarkName: 'Bibi',
  createdByName: 'Nguyễn A',
  createdAt: new Date('2026-11-20T03:00:00Z'),
  cogsHn: 108000,
  priceHnRetail: 162000,
};

const link =
  'https://pos.example/san-pham/bang-gia-san-pham-moi?Code=SPM000123';

function content(card: any): string {
  return card.elements[0].text.content;
}

describe('buildTicketCard', () => {
  it('thông báo Thu Mua có lời gửi, thông tin đề xuất và nút mở phiếu', () => {
    const built = buildTicketCard('ENTER_PURCHASING', ticket, {
      link,
      greetingNames: ['Linh'],
    });
    expect(built.title).toBe('Thông báo đề xuất sản phẩm mới');
    const text = content(built.card);
    expect(text).toContain('Gửi Linh,');
    expect(text).toContain('SPM000123');
    expect(text).toContain('Đề nghị Phòng thu mua bổ sung thông tin');
    expect((built.card as any).elements[1].actions[0].url).toBe(link);
  });

  it('card CEO kèm giá và % lãi', () => {
    const text = content(buildTicketCard('ENTER_CEO', ticket, { link }).card);
    expect(text).toContain('HN - Giá lẻ:** 162,000 đ (lãi 50%)');
    expect(text).toContain('HCM - Giá lẻ:** —');
  });

  it('CEO từ chối: nêu lý do, phân biệt kết thúc / làm lại', () => {
    const redo = content(
      buildTicketCard('CEO_REJECTED', ticket, { link, reason: 'Giá cao' }).card,
    );
    expect(redo).toContain('Giá cao');
    expect(redo).toContain('đề xuất lại');
    const ended = content(
      buildTicketCard('CEO_REJECTED', ticket, {
        link,
        reason: 'Ngừng',
        ended: true,
      }).card,
    );
    expect(ended).toContain('đã được kết thúc');
  });
});

describe('buildReminderCard', () => {
  it('liệt kê tối đa 20 phiếu', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({
      code: `SPM${i}`,
      productName: `SP ${i}`,
      days: i,
    }));
    const built = buildReminderCard('PURCHASING', items, 'https://pos/list');
    const text = content(built.card);
    expect(text).toContain('Phòng Thu Mua');
    expect(text).toContain('23 phiếu');
    expect(text).toContain('… và 3 phiếu khác');
    expect(built.body).toBe('23 phiếu đang chờ xử lý tại Phòng Thu Mua');
  });
});
