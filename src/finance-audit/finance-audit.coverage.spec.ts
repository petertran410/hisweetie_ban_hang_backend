import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import {
  CONTROLLER_WATERMARK,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { InternalFinanceController } from '../internal-finance/internal-finance.controller';
import {
  InternalFundApprovalController,
  InternalFundController,
} from '../internal-fund/internal-fund.controller';
import { VehiclesController } from '../vehicles/vehicles.controller';
import { VpsgCashController } from '../vpsg-cash/vpsg-cash.controller';
import {
  FINANCE_AUDIT_ACTIONS,
  isFinanceAuditAction,
} from './finance-audit.catalog';
import { FINANCE_ROUTE_AUDIT } from './finance-route-audit';

type ControllerClass = new (...args: never[]) => unknown;

const SRC = path.resolve(__dirname, '..');

/** Controller tài chính nội bộ mà mọi route ghi dữ liệu phải ghi lịch sử. */
const FINANCE_CONTROLLERS: ControllerClass[] = [
  InternalFinanceController,
  InternalFundController,
  InternalFundApprovalController,
  VehiclesController,
  VpsgCashController,
];

/** Thư mục có controller tài chính: controller mới ở đây cũng phải khai báo. */
const CONTROLLER_DIRS = [
  'internal-finance',
  'internal-fund',
  'vehicles',
  'vpsg-cash',
];

/** File khai báo mã (catalog, types, bản đồ route): không tính là nơi ghi mã. */
const DECLARATION_FILES = new Set(
  [
    'finance-audit/finance-audit.catalog.ts',
    'finance-audit/finance-audit.types.ts',
    'finance-audit/finance-route-audit.ts',
  ].map((file) => path.join(SRC, file)),
);

/** `Class.handler` của mọi route không phải GET (POST/PUT/PATCH/DELETE/...). */
function writeHandlers(controller: ControllerClass): string[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => {
      if (name === 'constructor') return false;
      const handler: unknown = Object.getOwnPropertyDescriptor(
        proto,
        name,
      )?.value;
      if (typeof handler !== 'function') return false;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined)
        return false;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        | RequestMethod
        | undefined;
      return (method ?? RequestMethod.GET) !== RequestMethod.GET;
    })
    .map((name) => `${controller.name}.${name}`);
}

/** Mọi file .ts trong src/ trừ spec và file khai báo mã. */
function emittingSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) return emittingSourceFiles(full);
    if (!item.name.endsWith('.ts') || item.name.endsWith('.spec.ts')) return [];
    return DECLARATION_FILES.has(full) ? [] : [full];
  });
}

/** Mã FIN_* viết dạng chuỗi trong code (bỏ dòng chú thích). */
function codeLiterals(file: string): string[] {
  const code = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
  return [...code.matchAll(/(['"`])(FIN_[A-Z0-9_]+)\1/g)].map(
    (match) => match[2],
  );
}

describe('Finance audit coverage', () => {
  it('lists every finance controller of the finance folders', () => {
    const found = CONTROLLER_DIRS.flatMap((dir) =>
      fs
        .readdirSync(path.join(SRC, dir))
        .filter((file) => file.endsWith('.controller.ts'))
        .flatMap((file) =>
          Object.values(
            jest.requireActual<Record<string, unknown>>(
              path.join(SRC, dir, file),
            ),
          ),
        ),
    )
      .filter(
        (value): value is ControllerClass =>
          typeof value === 'function' &&
          Reflect.getMetadata(CONTROLLER_WATERMARK, value) === true,
      )
      .map((controller) => controller.name)
      .sort();
    expect(found).toEqual(
      FINANCE_CONTROLLERS.map((controller) => controller.name).sort(),
    );
  });

  it('maps every non-GET handler in FINANCE_ROUTE_AUDIT, with no stale keys', () => {
    const handlers = FINANCE_CONTROLLERS.flatMap(writeHandlers);
    // Đọc được metadata route (không thì danh sách rỗng, so sánh vô nghĩa).
    expect(handlers).toContain('VpsgCashController.record');
    expect(handlers).not.toContain('InternalFinanceController.findAll');
    const missing = handlers.filter(
      (handler) => !Object.hasOwn(FINANCE_ROUTE_AUDIT, handler),
    );
    const stale = Object.keys(FINANCE_ROUTE_AUDIT).filter(
      (key) => !handlers.includes(key),
    );
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it('lists only catalog codes, each at most once per route', () => {
    const invalid = Object.entries(FINANCE_ROUTE_AUDIT).flatMap(
      ([route, codes]) =>
        codes
          .filter((code) => !isFinanceAuditAction(code))
          .map((code) => `${route}: ${code}`),
    );
    const duplicated = Object.entries(FINANCE_ROUTE_AUDIT).flatMap(
      ([route, codes]) =>
        codes
          .filter((code, index) => codes.indexOf(code) !== index)
          .map((code) => `${route}: ${code}`),
    );
    expect({ invalid, duplicated }).toEqual({ invalid: [], duplicated: [] });
  });

  it('emits every catalog code from at least one source file in src/', () => {
    const emitted = new Set(emittingSourceFiles(SRC).flatMap(codeLiterals));
    const unemitted = FINANCE_AUDIT_ACTIONS.filter(
      (code) => !emitted.has(code),
    );
    expect({ unemitted }).toEqual({ unemitted: [] });
  });
});
