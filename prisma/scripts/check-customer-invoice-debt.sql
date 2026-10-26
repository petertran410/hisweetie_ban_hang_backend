-- Đối soát công nợ khách hàng ĐANG HOẠT ĐỘNG:
--   Tổng nợ KH (customers."totalDebt")  so với  Nợ trên HĐ (Σ invoices."debtAmount", bỏ HĐ đã hủy status = 2)
-- Kèm các thành phần của công thức tính nợ (src/common/customer-debt.util.ts) để tìm nguyên nhân lệch.
-- Chỉ đọc. Bỏ dòng "WHERE ... ket_qua = 'Lệch'" ở cuối để xem tất cả khách.

WITH inv AS (
  SELECT "customerId" AS customer_id,
         COUNT(*)                                   AS so_hd,
         COUNT(*) FILTER (WHERE "debtAmount" > 0)   AS so_hd_con_no,
         SUM("grandTotal")                          AS tong_tien_hd,
         SUM("paidAmount")                          AS da_tra_tren_hd,
         SUM("debtAmount")                          AS no_tren_hd
  FROM invoices
  WHERE "customerId" IS NOT NULL AND status <> 2
  GROUP BY "customerId"
),
cf AS (
  SELECT "partnerId" AS customer_id,
         -- Phiếu thu: bỏ mã TTTUHD (giống công thức hệ thống)
         SUM(amount) FILTER (WHERE "isReceipt" AND code NOT LIKE 'TTTUHD%') AS phieu_thu,
         SUM(amount) FILTER (WHERE NOT "isReceipt")                         AS phieu_chi,
         -- Phiếu Cân bằng: chi làm tăng nợ, thu làm giảm nợ
         SUM(CASE WHEN code LIKE 'CB%' THEN CASE WHEN "isReceipt" THEN -amount ELSE amount END END) AS phieu_cb
  FROM cash_flows
  WHERE "partnerType" = 'C' AND "partnerId" IS NOT NULL AND status <> 2
  GROUP BY "partnerId"
),
ro AS (
  SELECT "customerId" AS customer_id,
         SUM("refundAmount") AS can_tru_tra_hang
  FROM return_orders
  WHERE "customerId" IS NOT NULL
    AND (status = 2 OR (status = 4 AND "refundType" IN ('debt_offset', 'cash_refund')))
  GROUP BY "customerId"
),
ket_qua AS (
  SELECT c.code                                   AS ma_kh,
         c.name                                   AS ten_kh,
         COALESCE(c."contactNumber", c.phone)     AS sdt,
         b.name                                   AS chi_nhanh,
         p.code                                   AS ma_kh_cha,
         c."totalDebt"                            AS tong_no_kh,
         COALESCE(inv.no_tren_hd, 0)              AS no_tren_hd,
         c."totalDebt" - COALESCE(inv.no_tren_hd, 0) AS chenh_lech,
         CASE WHEN ABS(c."totalDebt" - COALESCE(inv.no_tren_hd, 0)) < 1 THEN 'Khớp' ELSE 'Lệch' END AS ket_qua,
         COALESCE(inv.so_hd, 0)                   AS so_hd,
         COALESCE(inv.so_hd_con_no, 0)            AS so_hd_con_no,
         COALESCE(inv.tong_tien_hd, 0)            AS tong_tien_hd,
         COALESCE(inv.da_tra_tren_hd, 0)          AS da_tra_tren_hd,
         COALESCE(cf.phieu_thu, 0)                AS phieu_thu,
         COALESCE(cf.phieu_chi, 0)                AS phieu_chi,
         COALESCE(cf.phieu_cb, 0)                 AS phieu_cb,
         COALESCE(ro.can_tru_tra_hang, 0)         AS can_tru_tra_hang,
         -- Nợ tính lại theo công thức hệ thống; khác tong_no_kh => tổng nợ KH đang bị cũ
         COALESCE(inv.tong_tien_hd, 0) - COALESCE(cf.phieu_thu, 0)
           + COALESCE(cf.phieu_chi, 0) - COALESCE(ro.can_tru_tra_hang, 0) AS no_tinh_lai
  FROM customers c
  LEFT JOIN branches  b ON b.id = c."branchId"
  LEFT JOIN customers p ON p.id = c."parentId"
  LEFT JOIN inv ON inv.customer_id = c.id
  LEFT JOIN cf  ON cf.customer_id  = c.id
  LEFT JOIN ro  ON ro.customer_id  = c.id
  WHERE c."isActive" = true
)
SELECT *,
       CASE WHEN ABS(no_tinh_lai - tong_no_kh) >= 1 THEN 'Có' ELSE '' END AS tong_no_kh_bi_cu
FROM ket_qua
WHERE ket_qua = 'Lệch'
ORDER BY ABS(chenh_lech) DESC;
