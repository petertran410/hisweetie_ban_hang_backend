import {
  actorText,
  buildTopicReplyPost,
  pickTopicRoot,
  postToTopic,
} from './lark-topic';

describe('actorText', () => {
  it('tên + vai trò; thiếu tên → vai trò; thiếu cả hai → "Người xử lý"', () => {
    expect(actorText('Admin', 'CEO')).toBe('**Admin** (CEO)');
    expect(actorText('Admin')).toBe('**Admin**');
    expect(actorText(null, 'CEO')).toBe('CEO');
    expect(actorText('  ', null)).toBe('Người xử lý');
  });
});

describe('buildTopicReplyPost', () => {
  it('tiêu đề, hàng tag (chưa liên kết → tên đậm), dòng có **đậm**, link cuối', () => {
    const post = buildTopicReplyPost({
      title: 'CEO duyệt thay đổi giá vốn',
      mentions: [
        { name: 'Chị A', openId: 'ou_a' },
        { name: 'Anh B', openId: null },
      ],
      lines: ['**KTT** (Kế toán trưởng) đã duyệt.', '', 'Đề nghị CEO duyệt.'],
      link: { label: 'Mở phiếu để xử lý', url: 'https://pos/x' },
    });
    expect(post).toEqual({
      zh_cn: {
        title: 'CEO duyệt thay đổi giá vốn',
        content: [
          [
            { tag: 'at', user_id: 'ou_a', user_name: 'Chị A' },
            { tag: 'text', text: ' ' },
            { tag: 'text', text: 'Anh B', style: ['bold'] },
          ],
          [
            { tag: 'text', text: 'KTT', style: ['bold'] },
            { tag: 'text', text: ' (Kế toán trưởng) đã duyệt.' },
          ],
          [{ tag: 'text', text: 'Đề nghị CEO duyệt.' }],
          [{ tag: 'a', text: 'Mở phiếu để xử lý', href: 'https://pos/x' }],
        ],
      },
    });
  });

  it('chưa có ai để tag → nhắc cấu hình ở hàng đầu', () => {
    const post = buildTopicReplyPost({
      title: 't',
      mentions: [],
      lines: [],
      link: { label: 'Xem phiếu', url: 'u' },
    });
    expect(JSON.stringify(post.zh_cn.content[0])).toContain(
      'chưa cấu hình người nhận',
    );
  });
});

describe('pickTopicRoot', () => {
  it('lấy chủ đề đầu tiên của đúng nhóm, bỏ sự kiện không có group / nhóm khác', () => {
    const events = [
      { data: { kind: 'X' } },
      { data: { group: { chatId: 'oc_other', rootMessageId: 'om_o' } } },
      { data: { group: { chatId: 'oc_g', rootMessageId: null } } },
      { data: { group: { chatId: 'oc_g', rootMessageId: 'om_1' } } },
      { data: { group: { chatId: 'oc_g', rootMessageId: 'om_2' } } },
      { data: null },
    ];
    expect(pickTopicRoot(events, 'oc_g')).toBe('om_1');
    expect(pickTopicRoot(events, 'oc_none')).toBeNull();
  });
});

describe('postToTopic', () => {
  const rootCard = { header: 'root' };
  const replyPost = buildTopicReplyPost({
    title: 'Kế toán xử lý giá vốn',
    mentions: [{ name: 'Chị A', openId: 'ou_a' }],
    lines: [
      '**B** (Phòng Thu Mua) đã hoàn tất bước.',
      'Đề nghị Kế toán kiểm tra.',
    ],
    link: { label: 'Mở phiếu để xử lý', url: 'https://pos/x' },
  });

  function fakeClient(
    opts: { createFails?: boolean; replyFailFor?: string[] } = {},
  ) {
    let n = 0;
    const create = jest.fn(() =>
      Promise.resolve(
        opts.createFails
          ? { code: 232011, msg: 'bot not in chat' }
          : { code: 0, data: { message_id: `om_root${++n}` } },
      ),
    );
    const reply = jest.fn(({ path }: any) =>
      Promise.resolve(
        opts.replyFailFor?.includes(path.message_id)
          ? { code: 230011, msg: 'message deleted' }
          : { code: 0, data: { message_id: `om_reply_${path.message_id}` } },
      ),
    );
    return {
      client: { im: { message: { create, reply } } } as any,
      create,
      reply,
    };
  }

  const base = {
    chatId: 'oc_g',
    rootCard,
    replyPost,
    mentioned: ['Chị A'],
  };

  it('chưa có chủ đề → mở chủ đề (card gốc) rồi trả lời trong chủ đề', async () => {
    const { client, create, reply } = fakeClient();
    const res = await postToTopic(client, { ...base, existingRootId: null });
    expect(create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_g',
        msg_type: 'interactive',
        content: JSON.stringify(rootCard),
      },
    });
    expect(reply).toHaveBeenCalledWith({
      path: { message_id: 'om_root1' },
      data: {
        msg_type: 'post',
        content: JSON.stringify(replyPost),
        reply_in_thread: true,
      },
    });
    expect(res).toEqual({
      chatId: 'oc_g',
      mentioned: ['Chị A'],
      rootMessageId: 'om_root1',
      messageId: 'om_reply_om_root1',
      created: true,
      status: 'SENT',
    });
  });

  it('đã có chủ đề → chỉ trả lời, không mở chủ đề mới', async () => {
    const { client, create } = fakeClient();
    const res = await postToTopic(client, {
      ...base,
      existingRootId: 'om_old',
    });
    expect(create).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      rootMessageId: 'om_old',
      created: false,
      status: 'SENT',
    });
  });

  it('chủ đề cũ hỏng → báo onRootBroken, mở chủ đề mới, trả lời lại', async () => {
    const { client, create } = fakeClient({ replyFailFor: ['om_old'] });
    const broken = jest.fn();
    const res = await postToTopic(client, {
      ...base,
      existingRootId: 'om_old',
      onRootBroken: broken,
    });
    expect(broken).toHaveBeenCalledWith('om_old', expect.any(Error));
    expect(create).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      rootMessageId: 'om_root1',
      created: true,
      status: 'SENT',
    });
  });

  it('không mở được chủ đề → ERROR, không ném lỗi, không trả lời', async () => {
    const { client, reply } = fakeClient({ createFails: true });
    const res = await postToTopic(client, { ...base, existingRootId: null });
    expect(reply).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      rootMessageId: null,
      created: false,
      status: 'ERROR',
      error: 'Lark 232011: bot not in chat',
    });
  });

  it('chủ đề vừa mở mà trả lời lỗi → ERROR, không mở thêm chủ đề', async () => {
    const { client, create } = fakeClient({ replyFailFor: ['om_root1'] });
    const res = await postToTopic(client, { ...base, existingRootId: null });
    expect(create).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      rootMessageId: 'om_root1',
      created: true,
      status: 'ERROR',
    });
  });

  it('chưa cấu hình Lark → ERROR', async () => {
    const res = await postToTopic(undefined, { ...base, existingRootId: null });
    expect(res).toMatchObject({ status: 'ERROR', error: 'Chưa cấu hình Lark' });
  });
});
