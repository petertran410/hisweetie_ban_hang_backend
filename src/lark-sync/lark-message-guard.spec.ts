import {
  LARK_GUARD_BLOCKED_CODE,
  guardLarkMessages,
  parseLarkAllowlist,
  stripMentions,
} from './lark-message-guard';

function fakeClient(messageChats: Record<string, string> = {}) {
  const sent: string[] = [];
  const contents: string[] = [];
  const send = (payload: any) => {
    sent.push(payload?.data?.receive_id ?? payload?.path?.message_id);
    contents.push(payload?.data?.content);
    return Promise.resolve({ code: 0 });
  };
  const get = (payload: any) =>
    Promise.resolve({
      code: 0,
      data: {
        items: [{ chat_id: messageChats[payload?.path?.message_id] }],
      },
    });
  const client = {
    im: {
      message: {
        create: jest.fn(send),
        reply: jest.fn(send),
        get: jest.fn(get),
      },
      v1: { message: { create: jest.fn(send), reply: jest.fn(send) } },
    },
  };
  return { client: client as any, sent, contents };
}

const post = (userIds: string[]) =>
  JSON.stringify({
    zh_cn: {
      title: 'T',
      content: [
        userIds.map((id) => ({ tag: 'at', user_id: id, user_name: `N-${id}` })),
      ],
    },
  });

const silent = { warn: jest.fn() } as any;

describe('parseLarkAllowlist', () => {
  it('trống / không khai báo → không chặn', () => {
    expect(parseLarkAllowlist(undefined)).toBeNull();
    expect(parseLarkAllowlist(' , ')).toBeNull();
  });

  it('tách dấu phẩy, bỏ khoảng trắng', () => {
    expect([...parseLarkAllowlist(' ou_a , oc_b ')!]).toEqual(['ou_a', 'oc_b']);
  });
});

describe('guardLarkMessages', () => {
  it('chỉ gửi tới người trong danh sách, chặn người khác ở cả im.message và im.v1.message', async () => {
    const { client, sent } = fakeClient();
    guardLarkMessages(client, new Set(['ou_me']), silent);

    const ok = await client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: 'ou_me', msg_type: 'text', content: '{}' },
    });
    const blocked = await client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: 'ou_other', msg_type: 'text', content: '{}' },
    });
    const blockedV1 = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_group', msg_type: 'text', content: '{}' },
    });

    expect(ok.code).toBe(0);
    expect(blocked.code).toBe(LARK_GUARD_BLOCKED_CODE);
    expect(blockedV1.code).toBe(LARK_GUARD_BLOCKED_CODE);
    expect(sent).toEqual(['ou_me']);
  });

  it('chặn trả lời tin (reply) vì không biết ai trong chat', async () => {
    const { client, sent } = fakeClient();
    guardLarkMessages(client, new Set(['ou_me']), silent);
    const res = await client.im.message.reply({
      path: { message_id: 'om_1' },
      data: { msg_type: 'text', content: '{}' },
    });
    expect(res.code).toBe(LARK_GUARD_BLOCKED_CODE);
    expect(sent).toEqual([]);
  });
});

describe('nhóm Lark trong danh sách', () => {
  it('gửi vào nhóm được, nhưng bỏ tag người ngoài danh sách', async () => {
    const { client, sent, contents } = fakeClient();
    guardLarkMessages(client, new Set(['ou_me', 'oc_group']), silent);
    const res = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_group',
        msg_type: 'post',
        content: post(['ou_me', 'ou_other']),
      },
    });
    expect(res.code).toBe(0);
    expect(sent).toEqual(['oc_group']);
    const line = JSON.parse(contents[0]).zh_cn.content[0];
    expect(line[0]).toEqual({
      tag: 'at',
      user_id: 'ou_me',
      user_name: 'N-ou_me',
    });
    expect(line[1]).toEqual({ tag: 'text', text: '@N-ou_other' });
  });

  it('trả lời trong chủ đề: cho phép khi tin gốc thuộc nhóm trong danh sách', async () => {
    const { client, sent } = fakeClient({ om_ok: 'oc_group', om_x: 'oc_x' });
    guardLarkMessages(client, new Set(['ou_me', 'oc_group']), silent);
    const ok = await client.im.message.reply({
      path: { message_id: 'om_ok' },
      data: { msg_type: 'post', content: post([]), reply_in_thread: true },
    });
    const blocked = await client.im.message.reply({
      path: { message_id: 'om_x' },
      data: { msg_type: 'post', content: post([]), reply_in_thread: true },
    });
    expect(ok.code).toBe(0);
    expect(blocked.code).toBe(LARK_GUARD_BLOCKED_CODE);
    expect(sent).toEqual(['om_ok']);
  });
});

describe('stripMentions', () => {
  const allow = new Set(['ou_me']);
  it('tin text: giữ tag người trong danh sách, người khác thành chữ', () => {
    const content = JSON.stringify({
      text: '<at user_id="ou_me">Tôi</at> <at user_id="ou_b">B</at> xem',
    });
    expect(JSON.parse(stripMentions('text', content, allow)!).text).toBe(
      '<at user_id="ou_me">Tôi</at> @B xem',
    );
  });

  it('card: bỏ <at id=…> của người ngoài danh sách và @all', () => {
    const content = JSON.stringify({
      elements: [
        { text: '<at id=ou_me></at><at id=ou_b></at><at id=all></at>' },
      ],
    });
    expect(
      JSON.parse(stripMentions('interactive', content, allow)!).elements[0]
        .text,
    ).toBe('<at id=ou_me></at>@người nhận@người nhận');
  });
});
