-- Thêm quyền Hủy cho chức năng Thu hồi nợ.
-- Chạy thủ công trên database backend. Không xóa hoặc thay đổi quyền hiện có.

INSERT INTO permissions (
  name,
  resource,
  action,
  description,
  category,
  scope
)
VALUES (
  'debt_tickets:cancel',
  'debt_tickets',
  'cancel',
  'Hủy / kết thúc phiếu thu hồi nợ',
  'Khách hàng',
  'all'
)
ON CONFLICT (name) DO UPDATE SET
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  updated_at = NOW();
