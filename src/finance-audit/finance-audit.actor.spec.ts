import {
  auditActor,
  financeAuditSystemUserId,
  newOpId,
  systemActorName,
} from './finance-audit.actor';

describe('finance audit actors', () => {
  const ORIGINAL_ENV = process.env.FINANCE_AUDIT_SYSTEM_USER_ID;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined)
      delete process.env.FINANCE_AUDIT_SYSTEM_USER_ID;
    else process.env.FINANCE_AUDIT_SYSTEM_USER_ID = ORIGINAL_ENV;
  });

  it('builds a USER actor from an id or req.user', () => {
    const byId = auditActor.user(5);
    expect(byId).toEqual({
      userId: 5,
      kind: 'USER',
      trigger: 'http',
      opId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown as string,
    });
    expect(
      auditActor.user({ id: 5, name: ' An ' }, 'packing-slip', 'op-1'),
    ).toEqual({
      userId: 5,
      userName: 'An',
      kind: 'USER',
      trigger: 'packing-slip',
      opId: 'op-1',
    });
    expect(
      auditActor.user({ id: 5, name: '', email: 'a@x.test' }).userName,
    ).toBe('a@x.test');
  });

  it('uses the configured system user for non-user actors', () => {
    delete process.env.FINANCE_AUDIT_SYSTEM_USER_ID;
    expect(financeAuditSystemUserId()).toBe(1);
    process.env.FINANCE_AUDIT_SYSTEM_USER_ID = 'abc';
    expect(financeAuditSystemUserId()).toBe(1);
    process.env.FINANCE_AUDIT_SYSTEM_USER_ID = '42';
    expect(auditActor.system('LARK', 'lark-webhook', 9, 'op-2')).toEqual({
      userId: 42,
      kind: 'LARK',
      trigger: 'lark-webhook',
      onBehalfOfUserId: 9,
      opId: 'op-2',
    });
    expect(auditActor.system('CRON', 'cron:x').onBehalfOfUserId).toBeNull();
  });

  it('builds SCRIPT actors and display names', () => {
    const script = auditActor.script('import-office-ledger', 3, 'op-3');
    expect(script).toEqual({
      userId: 3,
      kind: 'SCRIPT',
      trigger: 'script:import-office-ledger',
      opId: 'op-3',
    });
    expect(systemActorName(script)).toBe('Script import-office-ledger');
    expect(systemActorName(auditActor.system('LARK', 'x'))).toBe(
      'Hệ thống (Lark Approval)',
    );
    expect(systemActorName(auditActor.system('SYSTEM', 'x'))).toBe(
      'Hệ thống (tự động)',
    );
    expect(systemActorName(auditActor.user(1))).toBeNull();
  });

  it('creates unique operation ids', () => {
    expect(newOpId()).not.toBe(newOpId());
  });
});
