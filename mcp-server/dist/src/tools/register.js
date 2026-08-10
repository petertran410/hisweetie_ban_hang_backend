import { z } from 'zod';
import { posRequest } from '../pos-api.js';
import { redis } from '../redis.js';
const pagination = {
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    currentItem: z.number().int().min(0).max(50_000).optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
};
const branchId = z.number().int().positive().optional();
const looseObject = z.record(z.unknown());
function result(data) {
    // MCP SDK requires structuredContent to be a JSON object (record), never an array/primitive.
    const structuredContent = data !== null && typeof data === 'object' && !Array.isArray(data)
        ? data
        : { data };
    return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent,
    };
}
function register(server, name, title, description, schema, handler, write = false) {
    server.registerTool(name, {
        title,
        description,
        inputSchema: schema,
        annotations: {
            readOnlyHint: !write,
            destructiveHint: name.includes('cancel'),
            idempotentHint: !write,
            openWorldHint: true,
        },
    }, async (input) => {
        if (!write)
            return result(await handler(input));
        const idempotencyKey = String(input.idempotencyKey ?? '');
        const cacheKey = `mcp:idempotency:${name}:${idempotencyKey}`;
        const cached = await redis.get(cacheKey);
        if (cached)
            return result(JSON.parse(cached));
        const lockKey = `${cacheKey}:lock`;
        const acquired = await redis.set(lockKey, '1', 'EX', 60, 'NX');
        if (!acquired)
            throw new Error('This idempotent operation is already in progress');
        try {
            const data = await handler(input);
            await redis.set(cacheKey, JSON.stringify(data), 'EX', 86_400);
            return result(data);
        }
        finally {
            await redis.del(lockKey);
        }
    });
}
export function registerTools(server) {
    register(server, 'crm_list_customers', 'List customers', 'List CRM customers with offset pagination.', {
        ...pagination, code: z.string().optional(), name: z.string().optional(), contactNumber: z.string().optional(),
        branchId, isActive: z.boolean().optional(), orderBy: z.string().optional(), orderDirection: z.enum(['asc', 'desc']).optional(),
    }, (input) => posRequest('GET', '/customers', { query: input, branchId: input.branchId }));
    register(server, 'crm_search_customers', 'Search customers', 'Search active customers by code, name or phone.', {
        search: z.string().min(1).max(200),
    }, (input) => posRequest('GET', '/customers/search', { query: input }));
    register(server, 'crm_get_customer', 'Get customer', 'Get a customer and CRM relationships by numeric ID.', {
        id: z.number().int().positive(),
    }, ({ id }) => posRequest('GET', `/customers/${id}`));
    register(server, 'crm_get_customer_by_code', 'Get customer by code', 'Get a customer by POS customer code.', {
        code: z.string().min(1).max(100),
    }, ({ code }) => posRequest('GET', `/customers/code/${encodeURIComponent(String(code))}`));
    register(server, 'crm_get_customer_totals', 'Get customer totals', 'Aggregate customer count, debt and sales.', {
        branchId, createdDateFrom: z.string().optional(), createdDateTo: z.string().optional(), isActive: z.boolean().optional(),
    }, (input) => posRequest('GET', '/customers/totals', { query: input, branchId: input.branchId }));
    register(server, 'crm_create_customer', 'Create customer', 'Create a CRM customer. addresses must contain at least one POS address.', {
        customer: looseObject.describe('CreateCustomerDto accepted by the POS API'),
        idempotencyKey: z.string().uuid(),
    }, ({ customer }) => posRequest('POST', '/customers', { body: customer }), true);
    register(server, 'crm_update_customer', 'Update customer', 'Update an existing CRM customer.', {
        id: z.number().int().positive(), customer: looseObject, idempotencyKey: z.string().uuid(),
    }, ({ id, customer }) => posRequest('PUT', `/customers/${id}`, { body: customer }), true);
    register(server, 'crm_get_customer_debt_timeline', 'Get debt timeline', 'Get customer debt and transaction timeline.', {
        id: z.number().int().positive(), includeChildren: z.boolean().optional(),
    }, ({ id, ...query }) => posRequest('GET', `/customers/${id}/debt-timeline`, { query }));
    register(server, 'crm_get_customer_debt_documents', 'Get debt documents', 'List customer debt documents from customer reports.', {
        ...pagination, customerId: z.number().int().positive().optional(), branchId, fromDate: z.string().optional(), toDate: z.string().optional(),
    }, (input) => posRequest('GET', '/reports/customer/debt-documents', { query: input, branchId: input.branchId }));
    register(server, 'crm_list_products', 'List products', 'List products with filters and pagination.', {
        ...pagination, search: z.string().optional(), branchId, isActive: z.boolean().optional(), categoryIds: z.string().optional(),
        orderBy: z.string().optional(), orderDirection: z.enum(['asc', 'desc']).optional(),
    }, (input) => posRequest('GET', '/products', { query: input, branchId: input.branchId }));
    register(server, 'crm_get_product', 'Get product', 'Get product details by numeric ID.', {
        id: z.number().int().positive(), branchId,
    }, ({ id, branchId }) => posRequest('GET', `/products/${id}`, { branchId: branchId }));
    register(server, 'crm_get_branch_inventory', 'Get branch inventory', 'Get inventory rows for one branch and optional product IDs.', {
        branchId: z.number().int().positive(), productIds: z.array(z.number().int().positive()).optional(),
    }, ({ branchId, productIds }) => posRequest('GET', '/inventories/by-branch', {
        query: { branchId, productIds: productIds?.join(',') }, branchId: branchId,
    }));
    register(server, 'crm_get_product_inventory_by_branches', 'Get product inventory by branches', 'Get product inventory across branches.', {
        productId: z.number().int().positive(),
    }, ({ productId }) => posRequest('GET', `/inventories/product/${productId}/branches`, { query: { productId } }));
    register(server, 'crm_get_product_inventory_logs', 'Get product inventory logs', 'Get paginated inventory movement logs.', {
        productId: z.number().int().positive(), branchId, page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(500).optional(),
    }, ({ productId, ...query }) => posRequest('GET', `/products/${productId}/inventory-logs`, { query, branchId: query.branchId }));
    register(server, 'crm_list_orders', 'List orders', 'List orders with CRM filters and pagination.', {
        ...pagination, search: z.string().optional(), status: z.string().optional(), customerId: z.number().int().positive().optional(),
        branchId, fromDate: z.string().optional(), toDate: z.string().optional(), orderBy: z.string().optional(), orderDirection: z.enum(['asc', 'desc']).optional(),
    }, (input) => posRequest('GET', '/orders', { query: input, branchId: input.branchId }));
    register(server, 'crm_get_order', 'Get order', 'Get complete order details.', {
        id: z.number().int().positive(), branchId,
    }, ({ id, branchId }) => posRequest('GET', `/orders/${id}`, { branchId: branchId }));
    register(server, 'crm_create_order', 'Create order', 'Create an order through POS business logic. Stock shortages may be returned as warnings.', {
        order: looseObject.describe('CreateOrderDto accepted by the POS API'), idempotencyKey: z.string().uuid(),
    }, ({ order }) => posRequest('POST', '/orders', { body: order, branchId: order.branchId }), true);
    register(server, 'crm_update_order', 'Update order', 'Update an order through POS business logic.', {
        id: z.number().int().positive(), order: looseObject, idempotencyKey: z.string().uuid(),
    }, ({ id, order }) => posRequest('PUT', `/orders/${id}`, { body: order, branchId: order.branchId }), true);
    register(server, 'crm_cancel_order', 'Cancel order', 'Cancel an order. Optionally cancel its payments and cash flows.', {
        id: z.number().int().positive(), cancelPayments: z.boolean().optional(), idempotencyKey: z.string().uuid(),
    }, ({ id, idempotencyKey: _, ...body }) => posRequest('PUT', `/orders/${id}/cancel`, { body }), true);
    register(server, 'crm_get_customer_product_price_history', 'Get price history', 'Get customer-specific order price history for a product.', {
        customerId: z.number().int().positive(), productId: z.number().int().positive(), type: z.string().optional(), branchId,
    }, (input) => posRequest('GET', '/orders/product-price-history', { query: input, branchId: input.branchId }));
    register(server, 'crm_list_invoices', 'List invoices', 'List invoices with CRM filters and pagination.', {
        ...pagination, search: z.string().optional(), branchId, fromDate: z.string().optional(), toDate: z.string().optional(),
        customerIds: z.array(z.number().int().positive()).optional(), orderBy: z.string().optional(), orderDirection: z.enum(['asc', 'desc']).optional(),
    }, (input) => posRequest('GET', '/invoices', { query: input, branchId: input.branchId }));
    register(server, 'crm_get_invoice', 'Get invoice', 'Get complete invoice details.', {
        id: z.number().int().positive(), branchId,
    }, ({ id, branchId }) => posRequest('GET', `/invoices/${id}`, { branchId: branchId }));
    register(server, 'crm_create_invoice_from_order', 'Create invoice from order', 'Issue an invoice from an order. This changes stock, debt and cash flow.', {
        orderId: z.number().int().positive(), invoice: looseObject.optional(), idempotencyKey: z.string().uuid(),
    }, ({ orderId, invoice }) => posRequest('POST', `/invoices/from-order/${orderId}`, { body: invoice ?? {} }), true);
    register(server, 'crm_record_invoice_payment', 'Record invoice payment', 'Record payment and create the corresponding POS cash flow.', {
        payment: looseObject.describe('CreateInvoicePaymentDto accepted by the POS API'), idempotencyKey: z.string().uuid(),
    }, ({ payment }) => posRequest('POST', '/invoice-payments', { body: payment }), true);
    register(server, 'crm_get_customer_report', 'Get customer report', 'Get customer sales, profit, debt or product report.', {
        viewType: z.enum(['CustomerBySale', 'CustomerByProfit', 'CustomerDebt', 'CustomerByProduct']),
        fromDate: z.string().optional(), toDate: z.string().optional(), branchId, customerId: z.number().int().positive().optional(),
        customerKeyword: z.string().optional(), page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(500).optional(),
    }, (input) => posRequest('GET', '/reports/customer/preview', { query: input, branchId: input.branchId }));
    register(server, 'crm_list_accessible_branches', 'List accessible branches', 'List branches available to the configured POS service account.', {}, () => posRequest('GET', '/branches/my-branches'));
}
//# sourceMappingURL=register.js.map