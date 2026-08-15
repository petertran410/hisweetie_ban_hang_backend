# Hisweetie POS — Public API

API đọc dữ liệu POS dành cho đối tác tích hợp (website, sàn TMĐT, CRM…).

Thiết kế bám theo tài liệu **KiotViet Public API** để đối tác đã quen KiotViet
tái sử dụng được client sẵn có.

- Base URL: `https://<domain>/api/public/v1`
- Xác thực: OAuth 2.0 `client_credentials`
- Giới hạn: **5000 request/giờ** cho mỗi client
- Đọc: 26 resource. Ghi: hiện mở cho `customers`

Khác biệt có chủ đích so với KiotViet:

| | KiotViet | Hisweetie POS |
|---|---|---|
| Header `Retailer` | bắt buộc | **không cần** (hệ thống dùng một cơ sở dữ liệu) |
| `Idempotency-Key` | không có | **có** — chống tạo trùng khi retry |
| Xoá dữ liệu | có | **không** — chỉ ngừng hoạt động hoặc huỷ |

---

## 1. Lấy access token

```bash
curl -X POST https://<domain>/api/public/v1/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=<CLIENT_ID>" \
  -d "client_secret=<CLIENT_SECRET>"
```

```json
{ "access_token": "eyJhbGciOi...", "expires_in": 3600, "token_type": "Bearer" }
```

Mọi request sau đó gắn header:

```
Authorization: Bearer <access_token>
```

Token mặc định sống 1 giờ. Nên lấy token mới khi gần hết hạn thay vì gọi lại
trước từng request.

---

## 2. Danh sách resource

```
GET /{resource}
GET /{resource}/{id}
```

| Nhóm | Resource |
|---|---|
| Hàng hoá | `products`, `categories`, `trademarks`, `inventories`, `price-books` |
| Khách hàng | `customers`, `customer-groups`, `customer-types` |
| Bán hàng | `orders`, `invoices`, `return-orders`, `consignments`, `sale-channels` |
| Mua hàng | `suppliers`, `supplier-groups`, `purchase-orders`, `order-suppliers`, `supplier-returns` |
| Kho | `transfers` |
| Tài chính | `cashflows`, `bank-accounts`, `surchages` |
| Hệ thống | `branches`, `users`, `locations`, `settings` |

> `surchages` (thiếu chữ *r*) giữ đúng chính tả của KiotViet để client cũ gọi được.

### Tham số truy vấn

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `lastModifiedFrom` | — | Lấy bản ghi có `updatedAt >= giá trị này` (đồng bộ tăng dần) |
| `lastModifiedTo` | — | Cận trên của mốc thời gian |
| `pageSize` | 20 | Số bản ghi mỗi trang, tối đa 100 |
| `currentItem` | 0 | Bỏ qua bao nhiêu bản ghi (offset) |
| `orderBy` | `updatedAt` | Trường sắp xếp |
| `orderDirection` | `asc` | `asc` hoặc `desc` |
| `includeInactive` | `false` | Lấy cả bản ghi đã ngừng hoạt động |
| `search` | — | Tìm theo tên/mã/số điện thoại tuỳ resource |
| `branchIds` | — | Lọc theo chi nhánh, phân tách bằng dấu phẩy |
| `customerIds` | — | Lọc theo khách hàng |
| `status` | — | Lọc theo trạng thái |
| `include` | — | Nạp kèm dữ liệu liên quan |

### Phản hồi

```json
{
  "total": 1523,
  "pageSize": 20,
  "currentItem": 0,
  "data": [ ... ],
  "timestamp": "2026-08-14T10:00:00.000Z"
}
```

### Ví dụ

```bash
# Trang đầu
curl "https://<domain>/api/public/v1/customers?pageSize=50" \
  -H "Authorization: Bearer <token>"

# Đơn hàng của 2 chi nhánh, kèm chi tiết và thanh toán
curl "https://<domain>/api/public/v1/orders?branchIds=1,2&include=details,payments" \
  -H "Authorization: Bearer <token>"

# Chi tiết một hoá đơn
curl "https://<domain>/api/public/v1/invoices/1234?include=details,payments,delivery" \
  -H "Authorization: Bearer <token>"
```

---

## 3. Đồng bộ tăng dần

Cách đồng bộ đúng:

1. Lần đầu gọi không có `lastModifiedFrom` để lấy toàn bộ.
2. **Lưu lại `timestamp`** trong phản hồi.
3. Lần sau truyền chính giá trị đó vào `lastModifiedFrom`.

```bash
# Lần đầu
curl "https://<domain>/api/public/v1/products?pageSize=100"
# → timestamp: "2026-08-14T10:00:00.000Z"

# Lần sau — chỉ lấy phần đã đổi
curl "https://<domain>/api/public/v1/products?lastModifiedFrom=2026-08-14T10:00:00.000Z"
```

**Dùng `timestamp` của máy chủ, không dùng giờ máy đối tác.** Lệch giờ giữa hai
bên sẽ làm bỏ sót bản ghi.

### Dữ liệu bị xoá

POS **không xoá cứng** bất kỳ bản ghi nghiệp vụ nào — chỉ chuyển trạng thái
(`status` = đã huỷ, hoặc `isActive` = false). Vì vậy:

- Không có danh sách `removedIds`.
- Bản ghi bị huỷ vẫn xuất hiện trong `lastModifiedFrom` với trạng thái mới.
- Muốn thấy bản ghi đã ngừng hoạt động, thêm `includeInactive=true`.

### Phân trang khi dữ liệu đang thay đổi

Phân trang dùng offset. Nếu duyệt nhiều trang trong lúc dữ liệu biến động, hãy
cố định khoảng thời gian để kết quả không xê dịch giữa các trang:

```
?lastModifiedFrom=...&lastModifiedTo=...&pageSize=100&currentItem=0
```

---

## 4. Endpoint bổ trợ

| Endpoint | Trả về |
|---|---|
| `GET /customers/{id}/addresses` | Địa chỉ giao hàng |
| `GET /customers/{id}/groups` | Nhóm khách hàng |
| `GET /customers/{id}/ledger` | Sổ công nợ (có dư nợ cộng dồn) |
| `GET /orders/{id}/payments` | Thanh toán của đơn |
| `GET /invoices/{id}/payments` | Thanh toán của hoá đơn |
| `GET /orders/{id}/delivery` | Giao hàng của đơn |
| `GET /invoices/{id}/delivery` | Giao hàng của hoá đơn |

---

## 5. Ghi dữ liệu

Hiện mở cho `customers`, `products` và `categories`. Các resource khác sẽ bổ sung sau.

| Resource | Tạo | Cập nhật | Ngừng hoạt động |
|---|---|---|---|
| `customers` | `POST /customers` | `PUT /customers/{id}` | `DELETE /customers/{id}` |
| `products` | `POST /products` | `PUT /products/{id}` | `POST /products/{id}/deactivate` |
| `categories` | `POST /categories` | `PUT /categories/{id}` | Không hỗ trợ |

Thân request dùng đúng cấu trúc POS đang dùng. Với khách hàng, `addresses` bắt buộc ít nhất 1 phần tử khi tạo mới. Với sản phẩm, `code` và `name` là bắt buộc; các trường tồn kho/giá/thuộc tính dùng đúng `CreateProductDto` của POS.

```bash
curl -X POST https://<domain>/api/public/v1/customers \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7f3a9c21-4e8b-4d1a-9c2f-1b5e6a7d8c90" \
  -d '{
    "name": "Nguyễn Văn A",
    "contactNumber": "0901234567",
    "addresses": [
      {
        "address": "12 Lê Lợi",
        "newCityCode": "79",
        "newCityName": "TP. Hồ Chí Minh",
        "newWardName": "Phường Bến Nghé",
        "isDefault": true
      }
    ]
  }'
```

### Idempotency-Key — chống tạo trùng

Khi gọi qua mạng, request có thể **timeout sau khi POS đã ghi xong**. Phía đối
tác thấy lỗi và gọi lại, kết quả là hai khách hàng trùng nhau.

Cách tránh: sinh một chuỗi ngẫu nhiên (UUID) cho mỗi thao tác, gửi qua header
`Idempotency-Key`. Khi gọi lại **cùng khoá đó**, POS trả lại kết quả đã lưu thay
vì tạo bản ghi mới.

| Tình huống | Kết quả |
|---|---|
| Lần đầu | Chạy nghiệp vụ, lưu phản hồi |
| Gọi lại cùng khoá, cùng nội dung | Trả lại phản hồi cũ, **không tạo mới** |
| Gọi lại khi lần đầu chưa xong | `409` — thử lại sau |
| Cùng khoá nhưng nội dung khác | `409` — khoá đã dùng cho request khác |
| Lần đầu lỗi | Khoá được giải phóng, gửi lại cùng khoá được |

Khoá giữ trong 24 giờ. **Mỗi thao tác một khoá mới** — dùng lại khoá cũ cho việc
khác sẽ bị từ chối.

Không gửi `Idempotency-Key` vẫn gọi được, nhưng đối tác tự chịu rủi ro trùng.

### Ngừng hoạt động thay vì xóa

- `DELETE /customers/{id}` chỉ đặt `isActive = false`.
- `POST /products/{id}/deactivate` cập nhật `isActive = false`.
- Product/category không có `DELETE`: service POS hiện xóa cứng với endpoint đó, trái nguyên tắc giữ dữ liệu.
- Tất cả bản ghi ngừng hoạt động vẫn đọc lại được bằng `includeInactive=true`.

### Ghi nhận trong nhật ký

Mọi thao tác ghi qua Public API được ghi nhật ký POS dưới danh nghĩa tài khoản
quản trị mặc định. Đổi qua biến môi trường `PUBLIC_API_ACTING_USER_ID`.

---

## 6. Webhook

Thay vì hỏi liên tục, đăng ký webhook để POS chủ động báo khi có thay đổi.

### Đăng ký

```bash
curl -X POST https://<domain>/api/public/v1/webhooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "resource": "customers",
    "url": "https://partner.example/hooks/pos-customers",
    "secret": "chuoi-bi-mat-toi-thieu-16-ky-tu"
  }'
```

- `url` **bắt buộc HTTPS** — payload chứa dữ liệu khách hàng và đơn hàng.
- Đăng ký lại cùng `resource` + `url` sẽ cập nhật bản cũ và đặt lại bộ đếm lỗi.
- Mốc quét bắt đầu từ lúc đăng ký, **không dội lại lịch sử**.

### Quản lý

```bash
GET    /webhooks           # danh sách
GET    /webhooks/{id}      # chi tiết + 20 lần gọi gần nhất
DELETE /webhooks/{id}      # huỷ đăng ký
```

### Payload gửi tới đối tác

```json
{
  "resource": "customers",
  "total": 3,
  "data": [ ... ],
  "timestamp": "2026-08-14T10:05:00.000Z"
}
```

### Xác minh chữ ký

Nếu có `secret`, mỗi lần gọi kèm header `X-Webhook-Signature` = HMAC SHA-256 của
body. Luôn kiểm tra trước khi xử lý:

```js
const crypto = require('crypto');

function verify(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

Dùng **raw body**, không phải object đã parse — thứ tự khoá sau khi parse lại có
thể khác, chữ ký sẽ không khớp.

### Quy tắc gửi lại

| Tình huống | Xử lý |
|---|---|
| Phản hồi 2xx | Thành công, mốc quét tiến lên |
| Mã lỗi hoặc quá 5 giây | Thất bại — **mốc quét giữ nguyên**, lô dữ liệu gửi lại ở chu kỳ sau |
| Lỗi 10 lần liên tiếp | Tạm ngưng gọi. Đăng ký lại để kích hoạt |

Nghĩa là **không mất dữ liệu khi endpoint tạm chết**, nhưng đối tác phải chịu
được nhận trùng — hãy xử lý theo hướng idempotent, đối chiếu theo `id`.

Chu kỳ quét là mỗi phút, nên tin báo trễ tối đa khoảng một phút.

---

## 7. Mã lỗi

| Mã | Ý nghĩa |
|---|---|
| 400 | Tham số sai hoặc resource không tồn tại |
| 401 | Thiếu token, token sai hoặc hết hạn |
| 404 | Không tìm thấy bản ghi |
| 409 | Xung đột `Idempotency-Key` (xem mục 5) |
| 429 | Vượt 5000 request/giờ |

---

## 8. Dữ liệu không được trả ra

Vì lý do bảo mật, các trường sau luôn bị loại khỏi phản hồi:

- **Khách hàng**: số CCCD/CMND, tài khoản ngân hàng
- **Người dùng**: mật khẩu, thông tin phân quyền
- **Mọi resource**: khoá đồng bộ nội bộ (KiotViet, Lark, Misa), người tạo/sửa

`users` chỉ trả: `id`, `name`, `email`, `phone`, `avatar`, `branchId`,
`isActive`, `createdAt`, `updatedAt`.

---

## 9. Tạo client

Quản trị viên POS chạy:

```bash
npx ts-node prisma/seeds/create-public-api-client.ts "Tên đối tác"
```

`client_secret` chỉ hiện **một lần** duy nhất lúc tạo.
