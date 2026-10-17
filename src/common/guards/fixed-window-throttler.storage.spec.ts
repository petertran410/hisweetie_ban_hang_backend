import { FixedWindowThrottlerStorage } from './fixed-window-throttler.storage';

describe('FixedWindowThrottlerStorage', () => {
  const TTL = 60_000;
  let storage: FixedWindowThrottlerStorage;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-17T09:00:00Z'));
    storage = new FixedWindowThrottlerStorage();
  });

  afterEach(() => {
    storage.dispose();
    jest.useRealTimers();
  });

  const hit = (key = 'k', limit = 3) =>
    storage.increment(key, TTL, limit, TTL, 'default');

  it('counts hits and blocks once the limit is exceeded', async () => {
    expect((await hit()).isBlocked).toBe(false);
    expect((await hit()).isBlocked).toBe(false);
    const third = await hit();
    expect(third).toMatchObject({ totalHits: 3, isBlocked: false });

    const fourth = await hit();
    expect(fourth.isBlocked).toBe(true);
    expect(fourth.timeToBlockExpire).toBe(60);
  });

  it('does not count hits while blocked', async () => {
    for (let i = 0; i < 4; i++) await hit();
    const blocked = await hit();
    expect(blocked).toMatchObject({ totalHits: 4, isBlocked: true });
  });

  it('starts a fresh window after ttl', async () => {
    await hit();
    await hit();
    jest.advanceTimersByTime(TTL);
    expect(await hit()).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('unblocks and counts from zero after the block expires', async () => {
    for (let i = 0; i < 4; i++) await hit();
    jest.advanceTimersByTime(TTL - 1);
    expect((await hit()).isBlocked).toBe(true);
    jest.advanceTimersByTime(1);
    expect(await hit()).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('keeps keys independent (one blocked key does not affect others)', async () => {
    for (let i = 0; i < 4; i++) await hit('a');
    expect((await hit('a')).isBlocked).toBe(true);
    expect(await hit('b')).toMatchObject({ totalHits: 1, isBlocked: false });
    jest.advanceTimersByTime(TTL);
    // Block của "a" hết không được làm hỏng cửa sổ của "b".
    await hit('a');
    expect(await hit('b')).toMatchObject({ totalHits: 1, isBlocked: false });
  });
});
