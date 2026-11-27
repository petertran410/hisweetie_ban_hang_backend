import {
  LARK_GUARD_BLOCKED_CODE,
  guardLarkMessages,
  parseLarkAllowlist,
} from './lark-message-guard';

function fakeClient() {
  const sent: string[] = [];
  const send = (payload: any) => {
    sent.push(payload?.data?.receive_id ?? payload?.path?.message_id);
    return Promise.resolve({ code: 0 });
  };
  const client = {
    im: {
      message: { create: jest.fn(send), reply: jest.fn(send) },
      v1: { message: { create: jest.fn(send), reply: jest.fn(send) } },
    },
  };
  return { client: client as any, sent };
}

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
