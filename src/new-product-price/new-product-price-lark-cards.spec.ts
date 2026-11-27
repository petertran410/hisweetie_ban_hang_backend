import {
  buildReminderCard,
  buildTicketCard,
  buildTopicReply,
  buildTopicRootCard,
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

describe('chủ đề trong nhóm Lark', () => {
  it('tin mở chủ đề: người đề xuất + thông tin phiếu + nút xem phiếu', () => {
    const card = buildTopicRootCard(ticket, link) as any;
    expect(card.header.title.content).toBe(
      'Đề xuất sản phẩm mới SPM000123 — Siro Đào 750ml',
    );
    expect(card.elements[0].text.content).toContain(
      '**Nguyễn A** vừa đề xuất sản phẩm mới.',
    );
    expect(card.elements[1].actions[0].url).toBe(link);
  });

  it('tin trả lời (post chuẩn chung): tiêu đề tin riêng, hàng tag, người làm, lý do, câu đề nghị, link', () => {
    const ctx = { link, reason: 'Thiếu giá cost' };
    const built = buildTicketCard('SENT_BACK', ticket, ctx);
    const post = buildTopicReply('SENT_BACK', built, {
      ...ctx,
      actorName: 'Kế toán C',
      mentions: [
        { name: 'Chị A', openId: 'ou_a' },
        { name: 'Anh B', openId: null },
      ],
    });
    const [tags, done, reason, ask, linkLine] = post.zh_cn.content;
    expect(post.zh_cn.title).toBe('Yêu cầu bổ sung thông tin sản phẩm mới');
    expect(tags).toEqual([
      { tag: 'at', user_id: 'ou_a', user_name: 'Chị A' },
      { tag: 'text', text: ' ' },
      { tag: 'text', text: 'Anh B', style: ['bold'] },
    ]);
    expect(done).toEqual([
      { tag: 'text', text: 'Kế toán C', style: ['bold'] },
      { tag: 'text', text: ' trả về phiếu.' },
    ]);
    expect(reason).toEqual([
      { tag: 'text', text: 'Lý do:', style: ['bold'] },
      { tag: 'text', text: ' Thiếu giá cost' },
    ]);
    expect(ask).toEqual([{ tag: 'text', text: built.ask }]);
    expect(linkLine).toEqual([
      { tag: 'a', text: 'Mở phiếu để xử lý', href: link },
    ]);
  });

  it('KTT duyệt: ghi người duyệt + vai trò, "Ghi chú"; tạo SP xong: link Xem phiếu', () => {
    const okCtx = {
      link,
      decision: 'APPROVED' as const,
      decidedByName: 'Chị KTT',
      reason: 'OK',
    };
    const ok = buildTopicReply(
      'KTT_DECIDED',
      buildTicketCard('KTT_DECIDED', ticket, okCtx),
      { ...okCtx, mentions: [{ name: 'Kế toán', openId: 'ou_k' }] },
    );
    expect(ok.zh_cn.content[1]).toEqual([
      { tag: 'text', text: 'Chị KTT', style: ['bold'] },
      { tag: 'text', text: ' (Kế toán trưởng) đã duyệt giá vốn.' },
    ]);
    expect(ok.zh_cn.content[2][0]).toEqual({
      tag: 'text',
      text: 'Ghi chú:',
      style: ['bold'],
    });

    const done = buildTopicReply(
      'PRODUCT_CREATED',
      buildTicketCard('PRODUCT_CREATED', ticket, { link }),
      { link, actorName: 'Data', productCode: 'SP000999', mentions: [] },
    );
    expect(done.zh_cn.content[1]).toEqual([
      { tag: 'text', text: 'Data', style: ['bold'] },
      { tag: 'text', text: ' (Phòng Dữ Liệu) đã tạo sản phẩm ' },
      { tag: 'text', text: 'SP000999', style: ['bold'] },
      { tag: 'text', text: ' trên POS.' },
    ]);
    expect(done.zh_cn.content.at(-1)).toEqual([
      { tag: 'a', text: 'Xem phiếu', href: link },
    ]);
  });
});
