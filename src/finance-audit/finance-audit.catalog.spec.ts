import {
  AUDIT_TEMPLATES,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import {
  FINANCE_AUDIT_ACTIONS,
  FINANCE_AUDIT_CATALOG,
  FINANCE_AUDIT_TEMPLATES,
  isFinanceAuditAction,
} from './finance-audit.catalog';
import { FINANCE_AUDIT_ENTITY } from './finance-audit.types';

describe('finance audit catalog', () => {
  const entityTypes = new Set<string>(Object.values(FINANCE_AUDIT_ENTITY));

  it('defines every code with a valid entity, severity, type and template', () => {
    expect(FINANCE_AUDIT_ACTIONS.length).toBe(55);
    for (const code of FINANCE_AUDIT_ACTIONS) {
      const item = FINANCE_AUDIT_CATALOG[code];
      expect(code).toMatch(/^FIN_[A-Z_]+$/);
      expect(entityTypes.has(item.entityType)).toBe(true);
      expect(['info', 'warning', 'critical']).toContain(item.severity);
      expect(['POST', 'PUT', 'DELETE']).toContain(item.actionType);
      expect(item.template.trim()).not.toBe('');
    }
  });

  it('marks cancels as DELETE (record kept) and never as hard delete codes', () => {
    for (const code of FINANCE_AUDIT_ACTIONS.filter((c) =>
      c.endsWith('_CANCEL'),
    ))
      expect(FINANCE_AUDIT_CATALOG[code].actionType).toBe('DELETE');
    expect(FINANCE_AUDIT_ACTIONS.some((c) => c.includes('_DELETE'))).toBe(
      false,
    );
  });

  it('is merged into the global AUDIT_TEMPLATES with category internal_finance', () => {
    for (const code of FINANCE_AUDIT_ACTIONS) {
      expect(FINANCE_AUDIT_TEMPLATES[code]).toEqual({
        template: FINANCE_AUDIT_CATALOG[code].template,
        category: 'internal_finance',
        severity: FINANCE_AUDIT_CATALOG[code].severity,
      });
      expect(AUDIT_TEMPLATES[code]).toEqual(FINANCE_AUDIT_TEMPLATES[code]);
      expect(getCategoryFromActionCode(code)).toBe('internal_finance');
      expect(getSeverityFromActionCode(code)).toBe(
        FINANCE_AUDIT_CATALOG[code].severity,
      );
    }
    // Các mã cũ giữ nguyên.
    expect(getCategoryFromActionCode('ORDER_CREATE')).toBe('order');
    expect(getCategoryFromActionCode('CASHFLOW_DELETE')).toBe('payment');
  });

  it('recognises catalog codes only', () => {
    expect(isFinanceAuditAction('FIN_ENTRY_CREATE')).toBe(true);
    expect(isFinanceAuditAction('ORDER_CREATE')).toBe(false);
    expect(isFinanceAuditAction('toString')).toBe(false);
  });
});
