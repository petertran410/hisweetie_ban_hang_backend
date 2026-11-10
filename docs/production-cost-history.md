# Lich su gia thanh gia cong

## Trien khai do nguoi van hanh kiem soat

1. Review va dong bo cac cot nullable moi cua `Production` theo quy trinh DB cua
   he thong. Khong backfill snapshot, khong reset du lieu.
2. Sinh Prisma Client va build/restart backend, frontend sau khi schema san sang.
3. Review `prisma/maintenance/register-production-apply-cost-permission.ts`.
   Nguoi van hanh co the chay:

   ```sh
   yarn ts-node prisma/maintenance/register-production-apply-cost-permission.ts --execute
   ```

   Lenh nay ghi/upsert duy nhat dinh nghia `productions:apply_cost`. Khong xoa
   quyen, khong gan quyen cho Admin, vai tro, nguoi dung hay chi nhanh.
4. Cap quyen "Ap dung gia von gia cong" trong nhom San xuat cho dung nguoi va
   chi nhanh. Kiem tra ca grant/deny, thu hoi, Super Admin va pham vi tat ca kho.
   Khai bao source KHONG dong nghia quyen da ton tai/duoc cap tren DB.

## Hop dong API

- GET `/productions/cost-history` va `/productions/cost-history/chart`:
  `productId` bat buoc; `manufacturerId`, `fromDate`, `toDate`, `variantKey`,
  `page` (1-based), `pageSize` (toi da 100). Chart tra toan bo tap loc.
- GET `/productions/:id/cost-application-preview?scope=receiveBranch`:
  tra snapshot gia thanh va gia hien tai cua tung kho; can `productions:apply_cost`.
- POST `/productions/:id/apply-cost`:

  ```json
  {
    "basis": "batch",
    "scope": "receiveBranch",
    "expectedCosts": [{"branchId": 2, "cost": 100}]
  }
  ```

  Gia moi lay tu snapshot, khong lay `newCost` tu client cho phieu NSX moi.
  Tat ca kho dich phai co quyen, khop gia xem truoc. Gia thay doi, phieu da ap/huy,
  hoac quy cach thay doi tra loi xung dot. Phieu thieu snapshot khong duoc ap
  theo dot; khong suy doan don vi tu danh muc hien tai.
- Nhan phieu NSX moi khong chap nhan `newCost`/tham so ap gia. Nhan hang chi
  nhap so luong, chot snapshot va cong no. Payload cu cua phieu nha may cu van
  duoc ho tro nhung moi ghi gia deu kiem tra quyen chuyen biet tren kho dich.

## Kiem chung runtime sau trien khai

Dung DB thu nghiem da duoc nguoi van hanh dong bo: nhan va ap dong thoi, huy,
pham vi nhieu kho, cap/thu hoi quyen thuc te, CNY va du lieu cu thieu snapshot.
Unit/HTTP tests dung mock khong thay the kiem chung giao dich PostgreSQL thuc.
Ap gia chi ghi `Inventory.cost` va audit tren phieu; khong sua chung tu ban cu.
Bao cao nao dang doc gia von hien tai co the hien thi khac ma khong sua hoa don.
