# Test tồn loại tồn

Xem bản tóm tắt dễ đọc tại: [TEST-SUMMARY.md](./TEST-SUMMARY.md)

## Chạy nhanh

```bash
yarn test:condition-stock
```

## Các lệnh

| Lệnh | Giải thích |
|------|-----------|
| yarn test:condition-stock:unit | Unit test, không cần DB |
| yarn test:condition-stock:audit | Audit chỉ đọc DB |
| yarn test:condition-stock:clt | Xem trước runner CLT |
| yarn test:condition-stock:clt --apply | Chạy CLT transaction test (tự rollback) |
