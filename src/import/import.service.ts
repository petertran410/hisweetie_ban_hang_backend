import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';

@Injectable()
export class ImportService {
  constructor(private prisma: PrismaService) {}

  async importProducts(file: Express.Multer.File) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new BadRequestException('Excel file is empty');
    }

    const products: any[] = [];
    const errors: any[] = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      try {
        const codeValue = row.getCell(1).value;
        const nameValue = row.getCell(2).value;
        const descriptionValue = row.getCell(3).value;
        const categoryIdValue = row.getCell(4).value;
        const variantIdValue = row.getCell(5).value;
        const purchasePriceValue = row.getCell(6).value;
        const retailPriceValue = row.getCell(7).value;
        const collaboratorPriceValue = row.getCell(8).value;
        const stockQuantityValue = row.getCell(9).value;
        const minStockAlertValue = row.getCell(10).value;
        const isActiveValue = row.getCell(11).value;

        const product = {
          code: codeValue?.toString() || '',
          name: nameValue?.toString() || '',
          description: descriptionValue?.toString() || null,
          categoryId:
            categoryIdValue && categoryIdValue.toString()
              ? parseInt(categoryIdValue.toString())
              : null,
          variantId:
            variantIdValue && variantIdValue.toString()
              ? parseInt(variantIdValue.toString())
              : null,
          purchasePrice:
            purchasePriceValue && purchasePriceValue.toString()
              ? parseInt(purchasePriceValue.toString())
              : 0,
          retailPrice:
            retailPriceValue && retailPriceValue.toString()
              ? parseInt(retailPriceValue.toString())
              : 0,
          collaboratorPrice:
            collaboratorPriceValue && collaboratorPriceValue.toString()
              ? parseInt(collaboratorPriceValue.toString())
              : 0,
          stockQuantity:
            stockQuantityValue && stockQuantityValue.toString()
              ? parseInt(stockQuantityValue.toString())
              : 0,
          minStockAlert:
            minStockAlertValue && minStockAlertValue.toString()
              ? parseInt(minStockAlertValue.toString())
              : 0,
          isActive:
            isActiveValue && isActiveValue.toString()
              ? isActiveValue.toString().toLowerCase() === 'true'
              : true,
        };

        if (!product.code || !product.name) {
          errors.push({
            row: rowNumber,
            error: 'Code and Name are required',
          });
          return;
        }

        product['slug'] = this.generateSlug(product.name);
        products.push(product);
      } catch (error) {
        errors.push({
          row: rowNumber,
          error: error.message,
        });
      }
    });

    const imported: any[] = [];
    const failed: any[] = [];

    for (const product of products) {
      try {
        const created = await this.prisma.product.create({
          data: product,
        });
        imported.push(created);
      } catch (error) {
        failed.push({
          product: product.code,
          error: error.message,
        });
      }
    }

    return {
      total: products.length,
      imported: imported.length,
      failed: failed.length,
      errors: [...errors, ...failed],
    };
  }

  async importCustomers(file: Express.Multer.File) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new BadRequestException('Excel file is empty');
    }

    const customers: any[] = [];
    const errors: any[] = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      try {
        const codeValue = row.getCell(1).value;
        const nameValue = row.getCell(2).value;
        const phoneValue = row.getCell(3).value;
        const facebookValue = row.getCell(4).value;
        const zaloValue = row.getCell(5).value;
        const addressValue = row.getCell(6).value;
        const notesValue = row.getCell(7).value;
        const customerTypeIdValue = row.getCell(8).value;
        const isActiveValue = row.getCell(9).value;

        const customer = {
          code: codeValue?.toString() || null,
          name: nameValue?.toString() || '',
          phone: phoneValue?.toString() || null,
          facebook: facebookValue?.toString() || null,
          zalo: zaloValue?.toString() || null,
          address: addressValue?.toString() || null,
          notes: notesValue?.toString() || null,
          customerTypeId:
            customerTypeIdValue && customerTypeIdValue.toString()
              ? parseInt(customerTypeIdValue.toString())
              : null,
          isActive:
            isActiveValue && isActiveValue.toString()
              ? isActiveValue.toString().toLowerCase() === 'true'
              : true,
        };

        if (!customer.name) {
          errors.push({
            row: rowNumber,
            error: 'Name is required',
          });
          return;
        }

        customers.push(customer);
      } catch (error) {
        errors.push({
          row: rowNumber,
          error: error.message,
        });
      }
    });

    const imported: any[] = [];
    const failed: any[] = [];

    for (const customer of customers) {
      try {
        const created = await this.prisma.customer.create({
          data: customer,
        });
        imported.push(created);
      } catch (error) {
        failed.push({
          customer: customer.name,
          error: error.message,
        });
      }
    }

    return {
      total: customers.length,
      imported: customers.length,
      failed: failed.length,
      errors: [...errors, ...failed],
    };
  }

  async generateProductsTemplate() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Products');

    worksheet.columns = [
      { header: 'Code', key: 'code', width: 15 },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Category ID', key: 'categoryId', width: 12 },
      { header: 'Variant ID', key: 'variantId', width: 12 },
      { header: 'Purchase Price', key: 'purchasePrice', width: 15 },
      { header: 'Retail Price', key: 'retailPrice', width: 15 },
      { header: 'Collaborator Price', key: 'collaboratorPrice', width: 18 },
      { header: 'Stock Quantity', key: 'stockQuantity', width: 15 },
      { header: 'Min Stock Alert', key: 'minStockAlert', width: 15 },
      { header: 'Is Active', key: 'isActive', width: 10 },
    ];

    worksheet.addRow({
      code: 'SP001',
      name: 'Sample Product',
      description: 'Product description',
      categoryId: 1,
      variantId: 1,
      purchasePrice: 100000,
      retailPrice: 150000,
      collaboratorPrice: 120000,
      stockQuantity: 100,
      minStockAlert: 10,
      isActive: 'true',
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  async generateCustomersTemplate() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Customers');

    worksheet.columns = [
      { header: 'Code', key: 'code', width: 15 },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Facebook', key: 'facebook', width: 20 },
      { header: 'Zalo', key: 'zalo', width: 15 },
      { header: 'Address', key: 'address', width: 40 },
      { header: 'Notes', key: 'notes', width: 30 },
      { header: 'Customer Type ID', key: 'customerTypeId', width: 18 },
      { header: 'Is Active', key: 'isActive', width: 10 },
    ];

    worksheet.addRow({
      code: 'KH001',
      name: 'Nguyen Van A',
      phone: '0901234567',
      facebook: 'nguyenvana',
      zalo: '0901234567',
      address: '123 Street, District, City',
      notes: 'VIP customer',
      customerTypeId: 1,
      isActive: 'true',
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }
}
