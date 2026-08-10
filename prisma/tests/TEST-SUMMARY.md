# Test CLT — Tóm tắt

## Chức năng đã test

- Tạo phiếu CLT PENDING, chưa duyệt — ✅ PASS
- Duyệt phiếu CLT → ghi CLT_IN, recalc cache — ✅ PASS
- Sửa quantity giảm → xóa log cũ, ghi log mới — ✅ PASS
- Sửa quantity về 0 → giữ detail, bỏ log khỏi sổ cái — ✅ PASS
- Hủy phiếu đã duyệt → bucket về baseline — ✅ PASS
- CLT OUT vượt tồn bucket → bị chặn — ✅ PASS
- Sửa NSX → chuẩn hóa về ngày 01 của tháng — ✅ PASS
- Bán hàng bục rách → ghi SALE_OUT -qty — ✅ PASS
- Bán hàng cận date có chọn lô → ghi đúng expiryDate — ✅ PASS
- Xuất quà khuyến mãi → ghi SALE_OUT -qty PROMO — ✅ PASS
- Bán hàng thường → không ghi log tồn loại — ✅ PASS
- Validate bán cận date vượt tồn đúng lô → bị chặn — ✅ PASS
- Hủy hóa đơn → hoàn lại bucket và lô — ✅ PASS
- Nhập hàng NCC loại B → ghi PURCHASE_IN vào DAMAGED — ✅ PASS
- Khách trả hàng bục rách/cận date → ghi RETURN_IN — ✅ PASS
- Trả NCC hàng loại → ghi SUPPLIER_RETURN_OUT quantity âm — ✅ PASS
- Hoàn hàng ký gửi → ghi CONSIGNMENT_RETURN_IN kèm lô NSX — ✅ PASS
- Audit toàn bộ cache khớp sổ cái, không bucket/lô/hàng tốt âm — ✅ PASS

## Chức năng chưa test / có bug

- Trả NCC hàng cận date → ghi log vào lô null thay vì lô cụ thể — ❌ FAIL (cần migration thêm nearExpiryDate)
- Khách trả hàng cận date → ghi log vào lô null — ❌ FAIL (cần migration thêm nearExpiryDate)

## Cách chạy

```bash
yarn test:condition-stock          # chạy toàn bộ (unit + audit + preview)
yarn test:condition-stock:unit     # unit test không cần DB
yarn test:condition-stock:audit    # audit chỉ đọc DB
yarn test:condition-stock:clt --apply  # CLT transaction test (tự rollback)
```
