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
  MisaSaveVoucherResponseDto,
  MisaDeleteVoucherRequestDto,
  MisaDeleteVoucherResponseDto,
  MisaSaInvoiceDetailDto,
  MisaBuyerOverrideDto,
} from './dto';

const MISA_STOCK_CODE_BY_POS_BRANCH_ID: Record<number, string> = {
  1: 'KHOHCM',
  6: 'KHO1',
};

type MisaFailureStage =
  | 'invoice_not_found'
  | 'cancelled'
  | 'already_synced'
  | 'missing_misa_code'
  | 'missing_inventory_item'
  | 'missing_stock'
  | 'build_payload'
  | 'misa_request'
  | 'misa_rejected';

type MisaVoucherResult = {
  success: boolean;
  orgRefId: string | null;
  message: string;
  stage?: MisaFailureStage;
};

class MisaVoucherStageError extends Error {
  constructor(
    public readonly stage: MisaFailureStage,
    message: string,
  ) {
    super(message);
    this.name = 'MisaVoucherStageError';
  }
}

type MisaInvoiceBuildDetail = MisaSaInvoiceDetailDto & {
  unit_price_after_tax?: number;
  cost_account?: string;
  is_promotion?: boolean;
};

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
    buyerOverride?: MisaBuyerOverrideDto,
    force = false,
  ): Promise<MisaVoucherResult> {
    let invoiceId: number | null = null;
    let branchId: number | null | undefined;
    let orgRefId: string | null = null;

    this.logger.log(
      `🧾 Creating Misa voucher for invoice code: ${invoiceCode}${
        force ? ' (force re-push)' : ''
      }`,
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
        this.logFailure(
          'invoice_not_found',
          invoiceCode,
          null,
          undefined,
          `Invoice not found: ${invoiceCode}`,
        );
        return {
          success: false,
          orgRefId: null,
          message: `Invoice not found: ${invoiceCode}`,
          stage: 'invoice_not_found',
        };
      }

      invoiceId = invoice.id;
      branchId = invoice.branchId;

      if (invoice.status === 2) {
        const message = `Invoice ${invoice.code} is cancelled`;
        this.logFailure('cancelled', invoice.code, null, branchId, message);
        return {
          success: false,
          orgRefId: null,
          message,
          stage: 'cancelled',
        };
      }

      if (
        !force &&
        (invoice.misaSyncStatus === 'SYNCED' || invoice.misaOrgRefId)
      ) {
        const message = `Invoice already sent to Misa: ${invoice.code}`;
        this.logFailure(
          'already_synced',
          invoice.code,
          invoice.misaOrgRefId,
          branchId,
          message,
        );
        return {
          success: false,
          orgRefId: invoice.misaOrgRefId,
          message,
          stage: 'already_synced',
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
          `⚠️ [stage=missing_misa_code] Invoice ${invoice.code} has ${productsWithoutMisaCode.length} product(s) without misa_code. Skipping...`,
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
          stage: 'missing_misa_code',
        };
      }

      orgRefId = invoice.misaOrgRefId || randomUUID();
      const voucherPayload = await this.buildVoucherPayload(
        invoice,
        orgRefId,
        buyerOverride,
      );

      if (!voucherPayload) {
        const message = `Failed to build voucher payload for invoice: ${invoice.code}`;
        this.logFailure(
          'build_payload',
          invoice.code,
          orgRefId,
          branchId,
          message,
        );
        return {
          success: false,
          orgRefId,
          message,
          stage: 'build_payload',
        };
      }

      const result = await this.sendVoucherToMisa(voucherPayload);

      if (result.success) {
        await this.prismaService.invoice.update({
          where: { id: invoice.id },
          data: {
            misaSyncStatus: 'PENDING',
            misaOrgRefId: orgRefId,
            misaSyncedAt: new Date(),
            misaSyncRetries: { increment: 1 },
            misaConfirmed: false,
            misaCallbackReceivedAt: null,
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
        ...(result.stage ? { stage: result.stage } : {}),
      };
    } catch (error) {
      const stage: MisaFailureStage =
        error instanceof MisaVoucherStageError ? error.stage : 'build_payload';
      const message = error.message;
      this.logFailure(stage, invoiceCode, orgRefId, branchId, message);

      this.logger.error(
        `❌ Error creating Misa voucher for invoice ${invoiceCode}: ${this.truncateLogValue(message)}`,
      );

      const persistedInvoice =
        invoiceId != null
          ? { id: invoiceId }
          : await this.prismaService.invoice.findUnique({
              where: { code: invoiceCode },
              select: { id: true },
            });

      if (persistedInvoice) {
        await this.prismaService.invoice.update({
          where: { id: persistedInvoice.id },
          data: {
            misaSyncStatus: 'FAILED',
            misaSyncRetries: { increment: 1 },
            misaErrorMessage: message,
          },
        });
      }

      return {
        success: false,
        orgRefId,
        message,
        stage,
      };
    }
  }

  private async buildVoucherPayload(
    invoice: any,
    orgRefId: string,
    buyerOverride?: MisaBuyerOverrideDto,
  ): Promise<MisaSaveVoucherRequestDto | null> {
    const orgCompanyCode = this.configService.get<string>(
      'MISA_ORG_COMPANY_CODE',
    );
    const branchId = this.configService.get<string>('MISA_BRANCH_ID');

    const misaStock = await this.resolveMisaStock(invoice.branchId);

    const employeeId = invoice.customer?.misaEmployeeId?.trim() || '';
    const employeeCode = invoice.customer?.misaEmployeeCode?.trim() || '';
    const employeeName = invoice.customer?.misaEmployeeName?.trim() || '';

    if (employeeCode) {
      this.logger.log(`✅ Employee mapping found for invoice ${invoice.code}`);
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
          `✅ Matched MisaAccountObject by companyTaxCode for invoice ${invoice.code}`,
        );
      } else {
        this.logger.log(
          `ℹ️ No MisaAccountObject found by companyTaxCode for invoice ${invoice.code}, using customer info`,
        );
      }
    }

    // ── Giá trị người mua "cuối cùng" gửi lên Misa ──
    // Mặc định: ưu tiên thông tin đã match trong MisaAccountObject, nếu không
    // có thì dùng thông tin khách hàng (giữ nguyên hành vi cũ).
    let resolvedBuyerName =
      matchedAccountObject?.accountObjectName || customerName;
    let resolvedBuyerTaxCode =
      matchedAccountObject?.companyTaxCode || customerTaxIdentifier;
    let resolvedBuyerAddress =
      matchedAccountObject?.address || invoice.customer?.invoiceAddress || '';

    // Ghi đè: chỉ khi CẢ 3 ô (mã số thuế, tên người mua, địa chỉ người mua)
    // đều có dữ liệu thì dùng chính 3 giá trị nhập tay thay cho thông tin trên.
    const overrideTaxCode = buyerOverride?.taxCode?.trim();
    const overrideBuyerName = buyerOverride?.buyerName?.trim();
    const overrideBuyerAddress = buyerOverride?.buyerAddress?.trim();
    const hasFullBuyerOverride =
      !!overrideTaxCode && !!overrideBuyerName && !!overrideBuyerAddress;

    if (hasFullBuyerOverride) {
      resolvedBuyerName = overrideBuyerName!;
      resolvedBuyerTaxCode = overrideTaxCode!;
      resolvedBuyerAddress = overrideBuyerAddress!;
      this.logger.log(`📝 Applied buyer override for invoice ${invoice.code}`);
    }

    const details: MisaInvoiceBuildDetail[] = [];
    let missingInventoryItemCount = 0;
    let totalSaleAmount = 0;
    const totalDiscountAmount = 0;
    let totalVatAmount = 0;

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
        missingInventoryItemCount++;
        this.logger.warn(
          `⚠️ [stage=missing_inventory_item] Inventory item not found for invoice ${invoice.code}`,
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
        account_object_name: resolvedBuyerName || undefined,

        stock_id: misaStock.stockId,
        stock_code: misaStock.stockCode,
        stock_name: misaStock.stockName,

        sort_order: i + 1,
        exchange_rate_operator: '*',
        is_promotion: false,
        is_description: false,
      });
    }

    if (details.length === 0) {
      const stage: MisaFailureStage =
        missingInventoryItemCount > 0
          ? 'missing_inventory_item'
          : 'build_payload';
      throw new MisaVoucherStageError(
        stage,
        `No valid details for voucher: ${invoice.code}`,
      );
    }

    const expectedTotalVat = Math.trunc(
      ((totalSaleAmount - totalDiscountAmount) * this.VAT_RATE) / 100,
    );
    const vatDiff = expectedTotalVat - totalVatAmount;

    if (vatDiff !== 0) {
      // Bù trừ chênh lệch làm tròn vào TIỀN TRƯỚC THUẾ của dòng đầu (giảm
      // amount) và cộng vào VAT, giữ nguyên thành tiền sau thuế của dòng — nhờ
      // vậy total_amount (sau thuế) luôn bằng tổng tiền hàng đã gồm thuế.
      details[0].vat_amount_oc = (details[0].vat_amount_oc ?? 0) + vatDiff;
      details[0].vat_amount = (details[0].vat_amount ?? 0) + vatDiff;
      details[0].amount_oc = (details[0].amount_oc ?? 0) - vatDiff;
      details[0].amount = (details[0].amount ?? 0) - vatDiff;
      totalVatAmount += vatDiff;
      totalSaleAmount -= vatDiff;
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
    const invoiceDate = this.formatDateForMisa(now);
    const createdDate = this.formatDateForMisa(now);
    const customerAddress = resolvedBuyerAddress;

    const voucher: MisaSaVoucherDto = {
      voucher_type: this.VOUCHER_TYPE,
      org_refid: orgRefId,
      org_refcode: orgRefId,
      org_refno: invoice.code,
      inv_refid: orgRefId,
      in_outward_refid: orgRefId,
      org_reftype: null,
      org_reftype_name: 'Chứng từ bán hàng hóa, dịch vụ trong nước',
      branch_id: branchId || '',
      reftype: this.REFTYPE,
      reftype_name: 'Hóa đơn bán hàng hóa, dịch vụ trong nước',
      posted_date: invoiceDate,
      refdate: invoiceDate,
      is_sale_with_outward: true,

      account_object_id: matchedAccountObject?.accountObjectId,
      account_object_code:
        matchedAccountObject?.accountObjectCode || customerTaxIdentifier,
      account_object_name: resolvedBuyerName,
      account_object_address: customerAddress,
      account_object_tax_code: resolvedBuyerTaxCode,

      employee_id: employeeId,
      employee_code: employeeCode,
      employee_name: employeeName,

      discount_type: 0,
      discount_rate_voucher: 0,
      exchange_rate: 1,
      currency_id: 'VND',
      include_invoice: 1,
      journal_memo: `Bán hàng - ${invoice.code}`,

      total_sale_amount_oc: totalSaleAmount,
      total_sale_amount: totalSaleAmount,
      total_amount_oc: totalSaleAmount + totalVatAmount,
      total_amount: totalSaleAmount + totalVatAmount,
      total_discount_amount_oc: totalDiscountAmount,
      total_discount_amount: totalDiscountAmount,
      total_vat_amount_oc: totalVatAmount,
      total_vat_amount: totalVatAmount,

      sa_invoice: {
        reftype: 3560,
        inv_date: invoiceDate,
        inv_type_id: 1,
        branch_id: branchId || '',
        account_object_id: matchedAccountObject?.accountObjectId,
        account_object_code:
          matchedAccountObject?.accountObjectCode || customerTaxIdentifier,
        account_object_name: resolvedBuyerName,
        account_object_address: customerAddress,
        account_object_tax_code: resolvedBuyerTaxCode,
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
        total_amount_oc: totalSaleAmount + totalVatAmount,
        total_amount: totalSaleAmount + totalVatAmount,
        total_discount_amount_oc: totalDiscountAmount,
        total_discount_amount: totalDiscountAmount,
        total_vat_amount_oc: totalVatAmount,
        total_vat_amount: totalVatAmount,
        detail: invoiceDetails,
      },

      in_outward: {
        refid: orgRefId,
        branch_id: branchId || '',
        reftype: this.OUTWARD_REFTYPE,
        reftype_name: 'Xuất kho bán hàng',
        posted_date: invoiceDate,
        refdate: invoiceDate,
        in_reforder: this.formatDateForMisa(invoice.purchaseDate),
        refno_finance: invoice.code,
        account_object_id: matchedAccountObject?.accountObjectId,
        account_object_code:
          matchedAccountObject?.accountObjectCode || customerTaxIdentifier,
        account_object_name: resolvedBuyerName,
        account_object_address: customerAddress,
        employee_id: employeeId,
        employee_code: employeeCode,
        employee_name: employeeName,
        journal_memo: `Xuất kho bán hàng - ${invoice.code}`,
      },

      detail: details,

      created_date: createdDate,
      created_by: this.DEFAULT_CREATED_BY,
      modified_date: createdDate,
      modified_by: this.DEFAULT_CREATED_BY,
    };

    return {
      org_company_code: orgCompanyCode || '',
      voucher: [voucher],
    };
  }

  private async resolveMisaStock(branchId: number | null | undefined): Promise<{
    stockId: string;
    stockCode: string;
    stockName: string;
  }> {
    const stockCode = branchId
      ? MISA_STOCK_CODE_BY_POS_BRANCH_ID[branchId]
      : undefined;

    if (!stockCode) {
      throw new MisaVoucherStageError(
        'missing_stock',
        `Chưa cấu hình kho Misa cho chi nhánh POS ${branchId ?? '(trống)'}`,
      );
    }

    const stock = await this.prismaService.misaStock.findFirst({
      where: {
        stockCode,
        inactive: false,
      },
      select: {
        stockId: true,
        stockCode: true,
        stockName: true,
      },
    });

    if (!stock) {
      throw new MisaVoucherStageError(
        'missing_stock',
        `Không tìm thấy kho Misa đang hoạt động với mã ${stockCode} cho chi nhánh POS ${branchId}`,
      );
    }

    return stock;
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

  private async sendVoucherToMisa(payload: MisaSaveVoucherRequestDto): Promise<{
    success: boolean;
    message: string;
    stage?: MisaFailureStage;
  }> {
    const baseUrl =
      this.configService.get<string>('MISA_BASE_URL')?.replace(/\/+$/, '') ||
      'https://developer.misa.vn/apis';
    const clientId = this.configService.get<string>('MISA_CLIENT_ID');
    const url = `${baseUrl}/amiskt/v1/save`;

    const orgRefId = payload.voucher?.[0]?.org_refid;
    const orgRefNo = payload.voucher?.[0]?.org_refno;

    try {
      if (!clientId) {
        throw new Error('Missing Misa configuration: MISA_CLIENT_ID');
      }

      const accessToken = await this.misaAuthService.getAccessToken();
      const response = await firstValueFrom(
        this.httpService.post<MisaSaveVoucherResponseDto>(url, payload, {
          headers: {
            'Content-Type': 'application/json',
            ClientID: clientId,
            'X-MISA-AccessToken': accessToken,
          },
        }),
      );

      const data = response.data;

      this.logger.log(
        `📥 Misa save response invoice=${orgRefNo} orgRefId=${orgRefId} ` +
          `httpStatus=${response.status} success=${data.Success} ` +
          `errorCode=${this.truncateLogValue(data.ErrorCode)} ` +
          `errorMessage="${this.truncateLogValue(data.ErrorMessage)}" ` +
          `data="${this.truncateLogValue(data.Data)}"`,
      );

      if (data.Success) {
        return {
          success: true,
          message: data.Data || 'Voucher queued successfully',
        };
      }

      this.logger.error(
        `❌ [stage=misa_rejected] Misa rejected voucher invoice=${orgRefNo} ` +
          `orgRefId=${orgRefId} errorCode=${this.truncateLogValue(data.ErrorCode)} ` +
          `errorMessage="${this.truncateLogValue(data.ErrorMessage)}"`,
      );
      return {
        success: false,
        message:
          [data.ErrorCode, data.ErrorMessage].filter(Boolean).join(': ') ||
          'Misa rejected voucher',
        stage: 'misa_rejected',
      };
    } catch (error: any) {
      const respData = error.response?.data;
      const status = error.response?.status ?? 'unknown';
      const message = respData
        ? `${error.message}: ${this.truncateLogValue(respData)}`
        : error.message;

      this.logger.error(
        `❌ [stage=misa_request] Misa save request failed invoice=${orgRefNo} ` +
          `orgRefId=${orgRefId} httpStatus=${status} ` +
          `error="${this.truncateLogValue(error.message)}" ` +
          `responseBody="${this.truncateLogValue(respData)}"`,
      );
      return {
        success: false,
        message,
        stage: 'misa_request',
      };
    }
  }

  private logFailure(
    stage: MisaFailureStage,
    invoiceCode: string,
    orgRefId: string | null,
    branchId: number | null | undefined,
    message: string,
  ): void {
    this.logger.warn(
      `⚠️ [stage=${stage}] Misa invoice failed invoice=${invoiceCode} ` +
        `orgRefId=${orgRefId ?? '(none)'} branchId=${branchId ?? '(none)'} ` +
        `message="${this.truncateLogValue(message)}"`,
    );
  }

  private truncateLogValue(value: unknown, maxLength = 500): string {
    if (value === undefined || value === null) return '';

    const text =
      typeof value === 'string'
        ? value
        : JSON.stringify(value) || String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
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
      if (
        invoice.misaSyncStatus === 'SYNCED' &&
        invoice.misaConfirmed === true
      ) {
        this.logger.log(
          `⏭️ Ignoring duplicate successful Misa callback for invoice ${invoice.code}`,
        );
        return;
      }

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

    const callbackError = `${errorCode || 'MisaError'}: ${
      errorMessage || 'Misa processing failed'
    }`;
    if (
      invoice.misaSyncStatus === 'FAILED' &&
      invoice.misaConfirmed === false &&
      invoice.misaErrorMessage === callbackError
    ) {
      this.logger.log(
        `⏭️ Ignoring duplicate failed Misa callback for invoice ${invoice.code}`,
      );
      return;
    }

    await this.prismaService.invoice.update({
      where: { id: invoice.id },
      data: {
        misaSyncStatus: 'FAILED',
        misaCallbackReceivedAt: new Date(),
        misaConfirmed: false,
        misaErrorMessage: callbackError,
      },
    });

    this.logger.error(
      `❌ Invoice ${invoice.code} failed to sync to Misa: ${callbackError}`,
    );
  }

  /**
   * Đẩy hàng loạt hóa đơn lên Misa theo danh sách mã.
   * Xử lý tuần tự để tránh vượt rate limit Misa + tránh refresh token trùng.
   */
  async createVouchersBulk(
    invoiceCodes: string[],
    buyerOverrides?: Record<string, MisaBuyerOverrideDto>,
    force = false,
  ): Promise<{
    success: boolean;
    message: string;
    total: number;
    successCount: number;
    failedCount: number;
    results: Array<{
      invoiceCode: string;
      success: boolean;
      orgRefId: string | null;
      message: string;
    }>;
  }> {
    this.logger.log(
      `📦 Bulk creating Misa vouchers for ${invoiceCodes.length} invoices`,
    );

    const results: Array<{
      invoiceCode: string;
      success: boolean;
      orgRefId: string | null;
      message: string;
    }> = [];
    let successCount = 0;
    let failedCount = 0;
    const failureSummary = new Map<MisaFailureStage, number>();

    for (let index = 0; index < invoiceCodes.length; index++) {
      const invoiceCode = invoiceCodes[index];
      const startedAt = Date.now();
      this.logger.log(
        `📦 Misa bulk invoice start ${index + 1}/${invoiceCodes.length} invoice=${invoiceCode}`,
      );

      try {
        const result = await this.createSaleVoucherFromInvoice(
          invoiceCode,
          buyerOverrides?.[invoiceCode],
          force,
        );
        results.push({
          invoiceCode,
          success: result.success,
          orgRefId: result.orgRefId,
          message: result.message,
        });
        if (result.success) {
          successCount++;
          this.logger.log(
            `✅ Misa bulk invoice done ${index + 1}/${invoiceCodes.length} ` +
              `invoice=${invoiceCode} durationMs=${Date.now() - startedAt}`,
          );
        } else {
          failedCount++;
          const stage = result.stage || 'build_payload';
          failureSummary.set(stage, (failureSummary.get(stage) || 0) + 1);
          this.logger.warn(
            `⚠️ Misa bulk invoice failed ${index + 1}/${invoiceCodes.length} ` +
              `invoice=${invoiceCode} stage=${stage} ` +
              `durationMs=${Date.now() - startedAt} ` +
              `message="${this.truncateLogValue(result.message)}"`,
          );
        }
      } catch (error: any) {
        failedCount++;
        const stage: MisaFailureStage = 'build_payload';
        failureSummary.set(stage, (failureSummary.get(stage) || 0) + 1);
        this.logger.error(
          `❌ Misa bulk invoice exception ${index + 1}/${invoiceCodes.length} ` +
            `invoice=${invoiceCode} stage=${stage} ` +
            `durationMs=${Date.now() - startedAt} ` +
            `message="${this.truncateLogValue(error.message)}"`,
        );
        results.push({
          invoiceCode,
          success: false,
          orgRefId: null,
          message: error.message,
        });
      }
    }

    this.logger.log(
      `📦 Bulk push done: ${successCount} success, ${failedCount} failed / ${invoiceCodes.length} total`,
    );

    if (failureSummary.size > 0) {
      const summary = [...failureSummary.entries()]
        .map(([stage, count]) => `${stage}=${count}`)
        .join(', ');
      this.logger.warn(`📊 Misa bulk failure summary: ${summary}`);
    }

    return {
      success: failedCount === 0,
      message: `Đã gửi ${successCount}/${invoiceCodes.length} hóa đơn vào hàng đợi Misa`,
      total: invoiceCodes.length,
      successCount,
      failedCount,
      results,
    };
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
    const baseUrl =
      this.configService.get<string>('MISA_BASE_URL')?.replace(/\/+$/, '') ||
      'https://developer.misa.vn/apis';
    const clientId = this.configService.get<string>('MISA_CLIENT_ID');
    const orgCompanyCode = this.configService.get<string>(
      'MISA_ORG_COMPANY_CODE',
    );
    const accessToken = await this.misaAuthService.getAccessToken();
    const url = `${baseUrl}/amiskt/v1/delete`;

    if (!clientId) {
      throw new Error('Missing Misa configuration: MISA_CLIENT_ID');
    }

    const payload: MisaDeleteVoucherRequestDto = {
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
            ClientID: clientId,
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
