-- KIỂM TRA ĐỘC LẬP việc sửa giá SP007601 trên hóa đơn cũ (÷ 1,08 thay × 0,92).
-- Chỉ có câu SELECT — chạy từng câu trong TablePlus, trước và sau khi chạy
-- scripts/fix-sp007601-legacy-price.ts --apply. Tính lại bằng SQL (không dùng code
-- của script) nên script sai thì các câu này sẽ bắt được.
--
-- "Hóa đơn cũ đã sửa" = hóa đơn chưa hủy, ngày bán trước mốc đổi giá
-- 2026-11-27 18:00 UTC, có dòng SP007601 đã chọn GTGT (0/5).


-- ① Từng dòng SP007601: so với giá gốc ở bản trước (HD…, HD….01 … còn dòng chưa chọn GTGT).
--    Trước --apply: tất cả "2. Còn ×0,92". Sau --apply: tất cả "1. Đúng ÷1,08".
--    HD138531.01: người dùng xác nhận 28/11 dùng đơn giá 150,000 (không phải
--    140,000 của bản gốc) để chia 1,08 → 150,000 ÷ 1,08 × 1,05 = 145,833.33.
WITH confirmed(code, p0, d0) AS (
  VALUES ('HD138531.01', 150000::numeric, 0::numeric)
),
cur AS (
  SELECT i.id, i.code, d.id AS did, d.price, d.discount, d.line_vat_rate AS r
  FROM invoices i
  JOIN invoice_details d ON d."invoiceId" = i.id
  WHERE d."productCode" = 'SP007601'
    AND d.line_vat_rate IS NOT NULL
    AND i.status <> 2
    AND i."purchaseDate" < '2026-11-27 18:00:00'
),
src AS (
  SELECT c.did, pd.price AS p0, pd.discount AS d0
  FROM cur c
  JOIN LATERAL (
    SELECT max(pi.code) AS code
    FROM invoices pi
    JOIN invoice_details pd ON pd."invoiceId" = pi.id
    WHERE split_part(pi.code, '.', 1) = split_part(c.code, '.', 1)
      AND pi.code < c.code
      AND pd."productCode" = 'SP007601'
      AND pd.line_vat_rate IS NULL
  ) v ON v.code IS NOT NULL
  JOIN invoices pi ON pi.code = v.code
  JOIN invoice_details pd ON pd."invoiceId" = pi.id
   AND pd."productCode" = 'SP007601' AND pd.line_vat_rate IS NULL
  WHERE c.code NOT IN (SELECT code FROM confirmed)
  UNION ALL
  SELECT c.did, cf.p0, cf.d0 FROM cur c JOIN confirmed cf ON cf.code = c.code
),
chk AS (
  SELECT c.id, c.code, c.did,
    coalesce(bool_or(
      abs(c.price - round(round(s.p0 / 1.08, 2) * (1 + c.r / 100), 2)) <= 0.01
      AND abs(c.discount - round(round(s.d0 / 1.08, 2) * (1 + c.r / 100), 2)) <= 0.01
    ), false) AS dung,
    coalesce(bool_or(
      abs(c.price - round(round(s.p0 * 0.92) * (1 + c.r / 100), 2)) <= 0.01
      AND abs(c.discount - round(round(s.d0 * 0.92) * (1 + c.r / 100), 2)) <= 0.01
    ), false) AS con_sai
  FROM cur c
  LEFT JOIN src s ON s.did = c.did
  GROUP BY c.id, c.code, c.did
)
SELECT CASE WHEN dung THEN '1. Đúng ÷1,08'
            WHEN con_sai THEN '2. Còn ×0,92 (chưa sửa)'
            ELSE '3. Khác giá gốc — xem tay' END AS "ketQua",
       count(*) AS "soDong",
       count(DISTINCT id) AS "soHoaDon",
       string_agg(DISTINCT code, ', ') FILTER (WHERE NOT dung AND NOT con_sai) AS "hoaDonXemTay"
FROM chk
GROUP BY 1
ORDER BY 1;


-- ② Xem tay 1 hóa đơn: giá gốc ở các bản trước và giá hiện tại (đổi mã ở dòng cuối).
SELECT i.code, i.status, d."productCode", d.line_vat_rate AS "gtgt",
       d.price, d.discount, d.quantity, d."totalPrice",
       i."totalAmount", i.discount AS "giamGiaDon", i."grandTotal", i."paidAmount", i."debtAmount"
FROM invoices i
JOIN invoice_details d ON d."invoiceId" = i.id
WHERE split_part(i.code, '.', 1) = split_part('HD138531.01', '.', 1)
  AND d."productCode" = 'SP007601'
ORDER BY i.code, d.id;


-- ③ Hóa đơn cộng tiền có khớp không. Phải RỖNG cả trước lẫn sau --apply.
--    Kiểm: thành tiền dòng SP007601 = (giá − giảm) × SL; tổng tiền hàng = cộng
--    các dòng; phải trả = tổng − giảm giá đơn + phí giao; còn nợ = phải trả − đã
--    trả; không số nào quá 2 số lẻ.
WITH inv AS (
  SELECT DISTINCT i.id
  FROM invoices i
  JOIN invoice_details d ON d."invoiceId" = i.id
  WHERE d."productCode" = 'SP007601'
    AND d.line_vat_rate IS NOT NULL
    AND i.status <> 2
    AND i."purchaseDate" < '2026-11-27 18:00:00'
),
lines AS (
  SELECT d."invoiceId" AS id,
         sum(d."totalPrice") AS "congDong",
         count(*) FILTER (
           WHERE d."productCode" = 'SP007601'
             AND d."totalPrice" <> round(round(d.price - d.discount, 2) * d.quantity, 2)
         ) AS "dongSaiThanhTien",
         count(*) FILTER (
           WHERE d.price <> round(d.price, 2)
              OR d.discount <> round(d.discount, 2)
              OR d."totalPrice" <> round(d."totalPrice", 2)
         ) AS "dongQua2SoLe"
  FROM invoice_details d
  JOIN inv ON inv.id = d."invoiceId"
  GROUP BY d."invoiceId"
)
SELECT i.code, i."totalAmount", l."congDong", i.discount, i."shippingFee",
       i."grandTotal", i."paidAmount", i."debtAmount", l."dongSaiThanhTien", l."dongQua2SoLe"
FROM invoices i
JOIN lines l ON l.id = i.id
WHERE i."totalAmount" <> l."congDong"
   OR i."grandTotal" <> i."totalAmount" - i.discount + i."shippingFee"
   OR i."debtAmount" <> i."grandTotal" - i."paidAmount"
   OR i."grandTotal" <> round(i."grandTotal", 2)
   OR i."debtAmount" <> round(i."debtAmount", 2)
   OR l."dongSaiThanhTien" > 0
   OR l."dongQua2SoLe" > 0
ORDER BY i.code;


-- ④ Công nợ khách có đúng công thức của app không (recalcCustomerDebt:
--    Σ phải trả HĐ chưa hủy − phiếu thu (trừ TTTUHD) + phiếu chi − cấn trừ trả hàng).
--    Phải RỖNG sau --apply.
WITH cus AS (
  SELECT DISTINCT i."customerId" AS id
  FROM invoices i
  JOIN invoice_details d ON d."invoiceId" = i.id
  WHERE d."productCode" = 'SP007601'
    AND d.line_vat_rate IS NOT NULL
    AND i.status <> 2
    AND i."purchaseDate" < '2026-11-27 18:00:00'
    AND i."customerId" IS NOT NULL
),
f AS (
  SELECT c.id, c.code, c."totalDebt",
    (SELECT coalesce(sum(x."grandTotal"), 0) FROM invoices x
      WHERE x."customerId" = c.id AND x.status <> 2)
    - (SELECT coalesce(sum(cf.amount), 0) FROM cash_flows cf
        WHERE cf."partnerId" = c.id AND cf."partnerType" = 'C' AND cf."isReceipt"
          AND cf.status <> 2 AND cf.code NOT LIKE 'TTTUHD%')
    + (SELECT coalesce(sum(cf.amount), 0) FROM cash_flows cf
        WHERE cf."partnerId" = c.id AND cf."partnerType" = 'C' AND NOT cf."isReceipt"
          AND cf.status <> 2)
    - (SELECT coalesce(sum(ro."refundAmount"), 0) FROM return_orders ro
        WHERE ro."customerId" = c.id
          AND (ro.status = 2 OR (ro.status = 4 AND ro."refundType" IN ('debt_offset', 'cash_refund'))))
    AS "dungCongThuc"
  FROM customers c
  JOIN cus ON cus.id = c.id
)
SELECT code, "totalDebt", "dungCongThuc", "totalDebt" - "dungCongThuc" AS "lech"
FROM f
WHERE abs("totalDebt" - "dungCongThuc") > 0.005
ORDER BY code;


-- ⑤ Con số tổng — chụp lại TRƯỚC --apply, chạy lại SAU --apply. Nếu giữa hai lần
--    không ai thu tiền / sửa HĐ của các khách này thì cả 2 cột phải tăng đúng bằng
--    "tổng tiền khách phải trả tăng" script in ra (dry-run 28/11: 7,605,821.69).
WITH inv AS (
  SELECT DISTINCT i.id, i."customerId"
  FROM invoices i
  JOIN invoice_details d ON d."invoiceId" = i.id
  WHERE d."productCode" = 'SP007601'
    AND d.line_vat_rate IS NOT NULL
    AND i.status <> 2
    AND i."purchaseDate" < '2026-11-27 18:00:00'
)
SELECT (SELECT count(*) FROM inv) AS "soHoaDon",
       (SELECT sum(i."grandTotal") FROM invoices i JOIN inv ON inv.id = i.id) AS "tongPhaiTra",
       (SELECT sum(c."totalDebt") FROM customers c
         WHERE c.id IN (SELECT "customerId" FROM inv)) AS "tongCongNoKhach";
