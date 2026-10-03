import 'reflect-metadata';
import { InvoicesController } from './invoices.controller';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';

describe('InvoicesController export permissions', () => {
  it.each([
    ['getDetailColumns', 'invoices:export'],
    ['exportOverview', 'invoices:export'],
    ['exportDetail', 'invoices:export'],
  ])('requires %s on %s', (methodName, permission) => {
    const permissions = Reflect.getMetadata(
      PERMISSIONS_KEY,
      InvoicesController.prototype[methodName as keyof InvoicesController],
    );

    expect(permissions).toEqual([permission]);
  });

  it('keeps invoice list access on invoices:view', () => {
    const permissions = Reflect.getMetadata(
      PERMISSIONS_KEY,
      InvoicesController.prototype.findAll,
    );

    expect(permissions).toEqual(['invoices:view']);
  });
});
