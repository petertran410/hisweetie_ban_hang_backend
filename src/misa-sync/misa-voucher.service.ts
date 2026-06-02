import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../prisma/prisma.service';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';
import { MisaAuthService } from './misa-auth.service';
import { MisaDictionaryService } from './misa-dictionary.service';
import { computeLineVat } from './misa-vat.util';
import {
  MisaSaveVoucherRequestDto,
  MisaSaVoucherDto,
  MisaSaVoucherDetailDto,
  MisaSaveVoucherResponseDto,
  MisaDeleteVoucherRequestDto,
  MisaDeleteVoucherResponseDto,
  MisaSaInvoiceDetailDto,
} from './dto';

@Injectable()
export class MisaVoucherService {
  private readonly logger = new Logger(MisaVoucherService.name);

  private readonly VOUCHER_TYPE = 13;
  private readonly REFTYPE = 3530;
  private readonly OUTWARD_REFTYPE = 2020;
  private readonly VAT_RATE = 8;
  private readonly DEFAULT_CREATED_BY = 'Trần Ngọc Nhân';

  private readonly DEBIT_ACCOUNT = '131';
  private readonly CREDIT_ACCOUNT = '5111';
  private readonly COST_ACCOUNT = '632';

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly prismaService: PrismaService,
    private readonly misaAuthService: MisaAuthService,
    private readonly misaDictionaryService: MisaDictionaryService,
  ) {}

  async createSaleVoucherFromInvoice(
    invoiceCode: string,
  ): Promise<{ success: boolean; orgRefId: string | null; message: string }> {
    this.logger.log(
      `🧾 Creating Misa voucher for invoice code: ${invoiceCode}`,
    );

    try {
      const invoice = await this.prismaService.invoice.findUnique({
        where: { code: invoiceCode },
        include: {
          details: {
            include: {
              product: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  misa_code: true,
                  misa_name: true,
                  misa_unit: true,
                  isCommerce: true,
                },
              },
            },
          },
          branch: { select: { id: true, name: true } },
          customer: {
            select: {
              id: true,
              name: true,
              invoiceAddress: true,
              taxCode: true,
              identificationNumber: true,
              misaEmployeeId: true,
              misaEmployeeCode: true,
              misaEmployeeName: true,
            },
          },
        },
      });

      if (!invoice) {
        return {
          success: false,
          orgRefId: null,
          message: `Invoice not found: ${invoiceCode}`,
        };
      }

      if (invoice.status === 2) {
        this.logger.log(`⏭️ Skipping cancelled invoice ${invoice.code}`);
        return {
          success: false,
          orgRefId: null,
          message: `Invoice ${invoice.code} is cancelled`,
        };
      }

      if (invoice.misaSyncStatus === 'SYNCED' || invoice.misaOrgRefId) {
        return {
          success: false,
          orgRefId: invoice.misaOrgRefId,
          message: `Invoice already sent to Misa: ${invoice.code}`,
        };
      }

      const productsWithoutMisaCode = invoice.details.filter(
        (detail) =>
          !detail.product?.misa_code || detail.product.misa_code.trim() === '',
      );

      if (productsWithoutMisaCode.length > 0) {
        const productCodes = productsWithoutMisaCode
          .map((detail) => detail.product?.code || detail.productCode)
          .join(', ');

        this.logger.warn(
          `⚠️ Invoice ${invoice.code} has products without misa_code: ${productCodes}. Skipping...`,
        );

        await this.prismaService.invoice.update({
          where: { id: invoice.id },
          data: {
            misaSyncStatus: 'SKIP',
            misaErrorMessage: `Products without misa_code: ${productCodes}`,
          },
        });

        return {
          success: false,
          orgRefId: null,
          message: `Invoice ${invoice.code} skipped: products without misa_code`,
        };
      }

      const orgRefId = invoice.misaOrgRefId || randomUUID();
      const voucherPayload = await this.buildVoucherPayload(invoice, orgRefId);

      if (!voucherPayload) {
        return {
          success: false,
          orgRefId: null,
          message: `Failed to build voucher payload for invoice: ${invoice.code}`,
        };
      }

      const result = await this.sendVoucherToMisa(voucherPayload);

      if (result.success) {
        await this.prismaService.invoice.update({
          where: { id: invoice.id },
          data: {
            misaSyncStatus: 'SYNCED',
            misaOrgRefId: orgRefId,
            misaSyncedAt: new Date(),
            misaSyncRetries: { increment: 1 },
            misaErrorMessage: null,
          },
        });
      } else {
        await this.prismaService.invoice.update({
          where: { id: invoice.id },
          data: {
            misaSyncStatus: 'FAILED',
            misaSyncRetries: { increment: 1 },
            misaErrorMessage: result.message,
          },
        });
      }

      return {
        success: result.success,
        orgRefId,
        message: result.message,
      };
    } catch (error) {
      this.logger.error(
        `❌ Error creating Misa voucher for invoice ${invoiceCode}: ${error.message}`,
      );

      const invoice = await this.prismaService.invoice.findUnique({
        where: { code: invoiceCode },
        select: { id: true },
      });

      if (invoice) {
        await this.prismaService.invoice.update({
          where: { id: invoice.id },
          data: {
            misaSyncStatus: 'FAILED',
            misaSyncRetries: { increment: 1 },
            misaErrorMessage: error.message,
          },
        });
      }

      return {
        success: false,
        orgRefId: null,
        message: error.message,
      };
    }
  }

  private async buildVoucherPayload(
    invoice: any,
    orgRefId: string,
  ): Promise<MisaSaveVoucherRequestDto | null> {
    const appId = this.configService.get<string>('MISA_APP_ID');
    const orgCompanyCode = this.configService.get<string>(
      'MISA_ORG_COMPANY_CODE',
    );
    const branchId = this.configService.get<string>('MISA_BRANCH_ID');

    const isHcmBranch = invoice.branchId === 3 || invoice.branchId === 1;

    const STOCK_HCM = {
      stockId: '012e030c-5815-4bb1-b7fc-2fc0fa295a34',
      stockCode: 'KHOHCM',
      stockName: 'KHO HỒ CHÍ MINH',
    };

    const STOCK_COMMERCE = {
      stockId: 'fb817711-7803-4948-8e1e-ea57ebe37240',
      stockCode: 'KHO1',
      stockName: 'KHO 1 - HÀNG THƯƠNG MẠI',
    };

    const STOCK_IMPORT = {
      stockId: '7efaa69c-e382-4a3d-932a-e2982464aa01',
      stockCode: 'KHONK',
      stockName: 'KHO NHẬP KHẨU',
    };

    const employeeId = invoice.customer?.misaEmployeeId?.trim() || '';
    const employeeCode = invoice.customer?.misaEmployeeCode?.trim() || '';
    const employeeName = invoice.customer?.misaEmployeeName?.trim() || '';

    if (employeeCode) {
      this.logger.log(
        `✅ Employee mapped for invoice ${invoice.code}: [${employeeCode}] ${employeeName}`,
      );
    } else {
      this.logger.warn(
        `⚠️ No employee mapped for customer of invoice ${invoice.code}`,
      );
    }

    const customerName =
      invoice.customerName || invoice.customer?.name || 'Khách lẻ';

    const accountObject =
      await this.misaDictionaryService.findAccountObjectByNameFuzzy(
        customerName,
      );

    const customerTaxIdentifier =
      invoice.customer?.taxCode || invoice.customer?.identificationNumber || '';

    let matchedAccountObject = accountObject;
    if (customerTaxIdentifier) {
      const matchedByTax = await this.prismaService.misaAccountObject.findFirst(
        {
          where: { companyTaxCode: customerTaxIdentifier },
        },
      );

      if (matchedByTax) {
        matchedAccountObject = matchedByTax;
        this.logger.log(
          `✅ Matched MisaAccountObject by companyTaxCode: ${customerTaxIdentifier} → ${matchedByTax.accountObjectCode}`,
        );
      } else {
        this.logger.log(
          `ℹ️ No MisaAccountObject found for companyTaxCode: ${customerTaxIdentifier}, using Customer info`,
        );
      }
    }

    const details: MisaSaVoucherDetailDto[] = [];
    let totalSaleAmount = 0;
    const totalDiscountAmount = 0;
    let totalVatAmount = 0;
    let totalAmount = 0;

    for (let i = 0; i < invoice.details.length; i++) {
      const detail = invoice.details[i];
      const product = detail.product;

      if (!product?.misa_code) {
        continue;
      }

      const inventoryItem =
        await this.misaDictionaryService.findInventoryItemByCode(
          product.misa_code,
        );

      if (!inventoryItem) {
        this.logger.warn(
          `⚠️ Inventory item not found for misa_code: ${product.misa_code}`,
        );
        continue;
      }

      const quantity = Number(detail.quantity);
      const {
        unitPriceAfterTax,
        unitPrice,
        amountBeforeTax,
        vatAmount,
        amountAfterTax,
      } = computeLineVat(
        {
          quantity: detail.quantity,
          price: detail.price,
          discount: detail.discount,
        },
        this.VAT_RATE,
      );

      totalSaleAmount += amountBeforeTax;
      totalVatAmount += vatAmount;
      totalAmount += amountAfterTax;

      details.push({
        inventory_item_id: inventoryItem.inventoryItemId,
        inventory_item_code: inventoryItem.inventoryItemCode,
        inventory_item_name: inventoryItem.inventoryItemName,
        inventory_item_type: 0,
        description: inventoryItem.inventoryItemName,

        unit_id: inventoryItem.unitId || undefined,
        unit_name: inventoryItem.unitName || product.misa_unit,
        main_unit_id: inventoryItem.unitId || undefined,
        main_unit_name: inventoryItem.unitName || product.misa_unit,

        quantity,
        main_quantity: quantity,
        main_convert_rate: 1,

        unit_price: unitPrice,
        unit_price_after_tax: unitPriceAfterTax,
        main_unit_price: unitPrice,
        amount_oc: amountBeforeTax,
        amount: amountBeforeTax,

        discount_rate: 0,
        discount_amount_oc: 0,
        discount_amount: 0,

        vat_rate: this.VAT_RATE,
        vat_amount_oc: vatAmount,
        vat_amount: vatAmount,

        debit_account:
          matchedAccountObject?.receiveAccount || this.DEBIT_ACCOUNT,
        credit_account: this.CREDIT_ACCOUNT,
        cost_account: this.COST_ACCOUNT,

        account_object_id: matchedAccountObject?.accountObjectId || undefined,
        account_object_code:
          matchedAccountObject?.accountObjectCode || undefined,
        account_object_name:
          matchedAccountObject?.accountObjectName || customerName || undefined,

        stock_id: isHcmBranch
          ? STOCK_HCM.stockId
          : product.isCommerce
            ? STOCK_COMMERCE.stockId
            : STOCK_IMPORT.stockId,
        stock_code: isHcmBranch
          ? STOCK_HCM.stockCode
          : product.isCommerce
            ? STOCK_COMMERCE.stockCode
            : STOCK_IMPORT.stockCode,
        stock_name: isHcmBranch
          ? STOCK_HCM.stockName
          : product.isCommerce
            ? STOCK_COMMERCE.stockName
            : STOCK_IMPORT.stockName,

        sort_order: i + 1,
        exchange_rate_operator: '*',
        is_promotion: false,
        is_description: false,
      });
    }

    if (details.length === 0) {
      this.logger.error('❌ No valid details for voucher');
      return null;
    }

    const expectedTotalVat = Math.trunc(
      ((totalSaleAmount - totalDiscountAmount) * this.VAT_RATE) / 100,
    );
    const vatDiff = expectedTotalVat - totalVatAmount;

    if (vatDiff !== 0) {
      details[0].vat_amount_oc = (details[0].vat_amount_oc ?? 0) + vatDiff;
      details[0].vat_amount = (details[0].vat_amount ?? 0) + vatDiff;
      totalVatAmount += vatDiff;
      totalAmount += vatDiff;
      this.logger.log(
        `🔧 Adjusted VAT difference: ${vatDiff} VND on first detail line`,
      );
    }

    const invoiceDetails: MisaSaInvoiceDetailDto[] = details.map((detail) => ({
      inventory_item_id: detail.inventory_item_id,
      inventory_item_code: detail.inventory_item_code,
      inventory_item_name: detail.inventory_item_name,
      inventory_item_type: detail.inventory_item_type,
      description: detail.description,

      unit_id: detail.unit_id,
      unit_name: detail.unit_name,
      main_unit_id: detail.main_unit_id,
      main_unit_name: detail.main_unit_name,

      quantity: detail.quantity,
      main_quantity: detail.main_quantity,
      main_convert_rate: detail.main_convert_rate,

      unit_price: detail.unit_price ?? 0,
      main_unit_price: detail.main_unit_price,
      amount_oc: detail.amount_oc,
      amount: detail.amount,
      amount_after_tax: detail.amount_oc + (detail.vat_amount_oc ?? 0),

      discount_rate: detail.discount_rate,
      discount_amount_oc: detail.discount_amount_oc,
      discount_amount: detail.discount_amount,

      vat_rate: detail.vat_rate,
      vat_amount_oc: detail.vat_amount_oc,
      vat_amount: detail.vat_amount,

      debit_account: detail.debit_account,
      credit_account: detail.credit_account,
      sale_account: detail.credit_account,

      account_object_id: detail.account_object_id,
      account_object_code: detail.account_object_code,
      account_object_name: detail.account_object_name,

      stock_id: detail.stock_id,
      stock_code: detail.stock_code,
      stock_name: detail.stock_name,

      sort_order: detail.sort_order,
      exchange_rate_operator: detail.exchange_rate_operator,
      is_description: false,
    }));

    const now = new Date();
    const misaDate = this.getMisaPostingDate(invoice.purchaseDate);
    const postedDate = this.formatDateForMisa(misaDate);
    const refDate = this.formatDateForMisa(misaDate);
    const inRefOrder = this.formatDateForMisa(invoice.purchaseDate);
    const createdDate = this.formatDateForMisa(now);
    const customerAddress =
      matchedAccountObject?.address || invoice.customer?.invoiceAddress || '';

    const voucher: MisaSaVoucherDto = {
      voucher_type: this.VOUCHER_TYPE,
      org_refid: orgRefId,
      org_refno: invoice.code,
      org_reftype: null,
      org_reftype_name: 'Chứng từ bán hàng hóa, dịch vụ trong nước',
      branch_id: branchId || '',
      reftype: this.REFTYPE,
      posted_date: postedDate,
      refdate: refDate,
      is_sale_with_outward: true,

      total_sale_amount_oc: totalSaleAmount,
      total_sale_amount: totalSaleAmount,
      total_amount_oc: totalAmount,
      total_amount: totalAmount,
      total_discount_amount_oc: totalDiscountAmount,
      total_discount_amount: totalDiscountAmount,
      total_vat_amount_oc: totalVatAmount,
      total_vat_amount: totalVatAmount,

      account_object_id: matchedAccountObject?.accountObjectId,
      account_object_code:
        matchedAccountObject?.accountObjectCode || customerTaxIdentifier,
      account_object_name:
        matchedAccountObject?.accountObjectName || customerName,
      account_object_address: customerAddress,
      account_object_tax_code:
        matchedAccountObject?.companyTaxCode || customerTaxIdentifier,

      employee_id: employeeId,
      employee_code: employeeCode,
      employee_name: employeeName,

      discount_type: 0,
      discount_rate_voucher: 0,
      exchange_rate: 1,
      currency_id: 'VND',
      include_invoice: 1,
      journal_memo: `Bán hàng - ${invoice.code}`,

      sa_invoice: {
        reftype: 3560,
        inv_date: postedDate,
        inv_type_id: 1,
        branch_id: branchId || '',
        account_object_id: matchedAccountObject?.accountObjectId,
        account_object_code:
          matchedAccountObject?.accountObjectCode || customerTaxIdentifier,
        account_object_name:
          matchedAccountObject?.accountObjectName || customerName,
        account_object_address: customerAddress,
        account_object_tax_code:
          matchedAccountObject?.companyTaxCode || customerTaxIdentifier,
        employee_id: employeeId,
        employee_code: employeeCode,
        employee_name: employeeName,
        exchange_rate: 1,
        currency_id: 'VND',
        discount_type: 0,
        discount_rate_voucher: 0,
        payment_method: 'TM/CK',
        buyer: '',
        total_sale_amount_oc: totalSaleAmount,
        total_sale_amount: totalSaleAmount,
        total_amount_oc: totalAmount,
        total_amount: totalAmount,
        total_discount_amount_oc: totalDiscountAmount,
        total_discount_amount: totalDiscountAmount,
        total_vat_amount_oc: totalVatAmount,
        total_vat_amount: totalVatAmount,
        detail: invoiceDetails,
      },

      in_outward: {
        branch_id: branchId || '',
        reftype: this.OUTWARD_REFTYPE,
        posted_date: postedDate,
        refdate: refDate,
        in_reforder: inRefOrder,
        account_object_id: matchedAccountObject?.accountObjectId,
        account_object_code:
          matchedAccountObject?.accountObjectCode || customerTaxIdentifier,
        account_object_name:
          matchedAccountObject?.accountObjectName || customerName,
        account_object_address: customerAddress,
        employee_id: employeeId,
        employee_code: employeeCode,
        employee_name: employeeName,
        journal_memo: `Xuất kho bán hàng - ${invoice.code}`,
      },

      created_date: createdDate,
      created_by: this.DEFAULT_CREATED_BY,
      modified_date: createdDate,
      modified_by: this.DEFAULT_CREATED_BY,
      detail: details,
    };

    return {
      app_id: appId || '',
      org_company_code: orgCompanyCode || '',
      voucher: [voucher],
    };
  }

  private formatDateForMisa(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  private getMisaPostingDate(purchaseDate: Date): Date {
    const vnHour = (purchaseDate.getUTCHours() + 7) % 24;
    if (vnHour >= 12 && vnHour < 19) {
      const nextDay = new Date(purchaseDate);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      nextDay.setUTCHours(1, 30, 0, 0);

      const vnNextDay = new Date(nextDay.getTime() + 7 * 60 * 60 * 1000);
      if (vnNextDay.getUTCDay() === 0) {
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      }

      return nextDay;
    }
    return purchaseDate;
  }

  private async sendVoucherToMisa(
    payload: MisaSaveVoucherRequestDto,
  ): Promise<{ success: boolean; message: string }> {
    const baseUrl = this.configService.get<string>('MISA_BASE_URL');
    const accessToken = await this.misaAuthService.getAccessToken();
    const url = `${baseUrl}/apir/sync/actopen/save`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<MisaSaveVoucherResponseDto>(url, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-MISA-AccessToken': accessToken,
          },
        }),
      );

      const data = response.data;

      if (data.Success) {
        return {
          success: true,
          message: data.Data || 'Voucher queued successfully',
        };
      }

      return {
        success: false,
        message: `${data.ErrorCode}: ${data.ErrorMessage}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }

  async handleMisaCallback(
    orgRefId: string,
    status: 'success' | 'failed',
    voucherId?: string,
    voucherNo?: string,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    this.logger.log(
      `📩 Received Misa callback for orgRefId: ${orgRefId}, status: ${status}`,
    );

    const invoice = await this.prismaService.invoice.findUnique({
      where: { misaOrgRefId: orgRefId },
    });

    if (!invoice) {
      this.logger.warn(`⚠️ Invoice not found for orgRefId: ${orgRefId}`);
      return;
    }

    if (status === 'success') {
      await this.prismaService.invoice.update({
        where: { id: invoice.id },
        data: {
          misaSyncStatus: 'SYNCED',
          misaCallbackReceivedAt: new Date(),
          misaConfirmed: true,
          misaErrorMessage: null,
        },
      });

      this.logger.log(
        `✅ Invoice ${invoice.code} confirmed synced to Misa (voucherId: ${voucherId}, voucherNo: ${voucherNo})`,
      );
      return;
    }

    await this.prismaService.invoice.update({
      where: { id: invoice.id },
      data: {
        misaSyncStatus: 'FAILED',
        misaCallbackReceivedAt: new Date(),
        misaConfirmed: false,
        misaErrorMessage: `${errorCode}: ${errorMessage}`,
      },
    });

    this.logger.error(
      `❌ Invoice ${invoice.code} failed to sync to Misa: ${errorCode} - ${errorMessage}`,
    );
  }

  async retryFailedInvoices(limit: number = 10): Promise<number> {
    const failedInvoices = await this.prismaService.invoice.findMany({
      where: {
        misaSyncStatus: 'FAILED',
        misaSyncRetries: { lt: 3 },
      },
      take: limit,
      orderBy: { misaSyncedAt: 'asc' },
    });

    let successCount = 0;

    for (const invoice of failedInvoices) {
      const result = await this.createSaleVoucherFromInvoice(invoice.code);
      if (result.success) {
        successCount++;
      }
    }

    this.logger.log(
      `🔄 Retried ${failedInvoices.length} failed invoices, ${successCount} succeeded`,
    );

    return successCount;
  }

  async deleteVoucherByInvoiceCode(invoiceCode: string): Promise<{
    success: boolean;
    message: string;
  }> {
    this.logger.log(
      `🗑️ Deleting Misa voucher for invoice code: ${invoiceCode}`,
    );

    try {
      const invoice = await this.prismaService.invoice.findUnique({
        where: { code: invoiceCode },
        select: {
          id: true,
          code: true,
          misaOrgRefId: true,
          misaSyncStatus: true,
        },
      });

      if (!invoice) {
        return {
          success: false,
          message: `Invoice not found: ${invoiceCode}`,
        };
      }

      if (!invoice.misaOrgRefId) {
        return {
          success: false,
          message: `Invoice ${invoiceCode} has no misaOrgRefId. Never synced to Misa.`,
        };
      }

      const result = await this.sendDeleteVoucherToMisa(invoice.misaOrgRefId);

      if (result.success) {
        await this.prismaService.invoice.update({
          where: { id: invoice.id },
          data: {
            misaSyncStatus: 'SKIP',
            misaOrgRefId: null,
            misaConfirmed: false,
            misaCallbackReceivedAt: null,
            misaSyncRetries: 0,
            misaErrorMessage: null,
          },
        });

        this.logger.log(`✅ Voucher deleted for invoice ${invoiceCode}`);
      } else {
        this.logger.error(
          `❌ Failed to delete voucher for invoice ${invoiceCode}: ${result.message}`,
        );
      }

      return result;
    } catch (error) {
      this.logger.error(
        `❌ Error deleting Misa voucher for invoice ${invoiceCode}: ${error.message}`,
      );

      return {
        success: false,
        message: error.message,
      };
    }
  }

  private async sendDeleteVoucherToMisa(
    orgRefId: string,
  ): Promise<{ success: boolean; message: string }> {
    const baseUrl = this.configService.get<string>('MISA_BASE_URL');
    const appId = this.configService.get<string>('MISA_APP_ID');
    const orgCompanyCode = this.configService.get<string>(
      'MISA_ORG_COMPANY_CODE',
    );
    const accessToken = await this.misaAuthService.getAccessToken();
    const url = `${baseUrl}/apir/sync/actopen/delete`;

    const payload: MisaDeleteVoucherRequestDto = {
      app_id: appId || '',
      org_company_code: orgCompanyCode || '',
      voucher: [
        {
          voucher_type: this.VOUCHER_TYPE,
          org_refid: orgRefId,
        },
      ],
    };

    try {
      const response = await firstValueFrom(
        this.httpService.delete<MisaDeleteVoucherResponseDto>(url, {
          headers: {
            'Content-Type': 'application/json',
            'X-MISA-AccessToken': accessToken,
          },
          data: payload,
        }),
      );

      const data = response.data;

      if (data.Success) {
        return {
          success: true,
          message: 'Voucher deleted successfully',
        };
      }

      return {
        success: false,
        message: `${data.ErrorCode}: ${data.ErrorMessage}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }
}
