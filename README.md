# Thống kê NS – Quét QR & nhập sản lượng

Web app chạy trên **Vercel**. Công nhân/thống kê tổ quét QR trên phiếu pallet → xem thông tin **chi tiết, cụm, sản phẩm**
→ chọn pallet → nhập sản lượng cho **1 hoặc nhiều công đoạn của chi tiết đó tại tổ đó** trong 1 lần lưu.

Dữ liệu: Google Sheet `Data NSCN` (`1VVW7Zrdw-KmO2HLIh1nchKE8DRGWDtd2hCrS-e_aKUU`).
Không cần build, không có thư viện npm.

## Mã QR

`<part_ref>-<mã tổ>`, giống phiếu pallet do app *Thong_Ke_NSCN* in. Ví dụ: `LSX-02-1626-01-W004-TC`.

| Mã tổ | `MO Routing.stage_group` | Tab `To` |
|---|---|---|
| SC | Sơ chế | T-SC |
| TC | Tinh chế | T-TC |
| LR | Lắp ráp | T-LR |
| DM | Dầu | T-DM |
| DG | Đóng gói | T-DG |

- Chỉ hiện và chỉ nhận các công đoạn của chi tiết **có `stage_group` thuộc tổ trong mã**. Server kiểm tra lại, nên không thể nhập lẫn công đoạn của tổ khác.
- Quét mã không có hậu tố tổ thì app vẫn hiện thông tin và cho chọn tổ.
- Quét được bằng camera điện thoại, máy quét cầm tay (gõ vào ô + Enter) hoặc mở link `/?code=…`.

## Đọc / ghi Sheet

| Tab | Đọc | Ghi |
|---|---|---|
| MO Routing, MO, MO Detail, Product, BOM Wood, Works List | ✔ | – |
| Users, To | ✔ (phân quyền) | – |
| Pallet | ✔ | Thêm pallet mới; đóng pallet → `status`, `closed_at`, `closed_by` |
| Pallet Log | ✔ | 1 dòng / công đoạn / lần lưu: `log_id, pallet_id, mo_route_id, work_date (dd/mm/yyyy), worker, qty, [qty_ng], note, created_by, created_at` |
| Scan | – | 1 dòng mỗi lần quét: `scan_id, mo_route_id, scanned_by, scanned_at` |

- App ghi theo **tên cột ở dòng tiêu đề**, nên thêm hay đổi thứ tự cột không làm lệch dữ liệu. Muốn ghi hàng NG thì thêm cột `qty_ng` vào Pallet Log, ô nhập NG sẽ tự hiện.
- Số đã làm của mỗi công đoạn = max(`MO Routing.qty_done`, tổng `Pallet Log.qty`), cùng quy tắc với báo cáo sản lượng của app cũ. App **không sửa** MO Routing.
- **Huỷ** một dòng nhập sai: app không xoá dòng đó mà ghi thêm 1 dòng âm (`note = "HUỶ <log_id> – tên"`), cùng ngày làm, nên lịch sử vẫn còn và báo cáo tự trừ đúng.
- Chữ người dùng nhập (số pallet, lô, ghi chú…) được ghi dạng text, nên không bị Sheet tự đổi thành ngày hay chạy thành công thức.

## Phân quyền

1. **Đăng nhập Google**: email phải có trong tab **Users** với `active = TRUE`. Nếu đặt `ALLOWED_DOMAIN` thì chỉ nhận email thuộc tên miền đó.
2. **Quyền nhập theo tổ**:
   - `role` bắt đầu bằng *Admin, Quản trị, Kỹ thuật, Quản đốc, Quản lý, Giám đốc*: nhập được mọi tổ, mở lại pallet đã đóng, huỷ dòng của người khác.
   - Các vai trò khác: chỉ nhập cho tổ có email của mình trong tab **To**, ở cột `manager_email` hoặc `thong_ke_emails` (nhiều email cách nhau bằng dấu phẩy). Có thể thêm cột tuỳ chọn `teams` vào Users, ví dụ `SC, TC`.
   - `role = Xem`: chỉ xem.
3. Khoá người dùng bằng cách đặt `active = FALSE`, có tác dụng sau tối đa khoảng 1 phút.
4. Người nhập được tự huỷ dòng của mình **trong ngày**. Quá ngày thì quản lý huỷ.
5. Ngày làm không được ở tương lai. Người không phải quản lý chỉ được nhập lùi tối đa `MAX_BACKDATE_DAYS` ngày (mặc định 7).

## Triển khai

### 1. Google Cloud (1 project)

1. **OAuth Client ID**: APIs & Services → Credentials → Create credentials → OAuth client ID → *Web application*.
   Ở *Authorized JavaScript origins*, thêm `https://<tên-app>.vercel.app` (và tên miền riêng nếu có).
   Lấy Client ID để đặt vào `GOOGLE_CLIENT_ID`. OAuth consent screen chọn *Internal* nếu dùng Google Workspace công ty.
2. **Service Account**: bật *Google Sheets API*. Tạo Service Account, vào Keys → Add key → JSON và tải file JSON về.
3. **Chia sẻ Google Sheet** cho email của Service Account (`…@….iam.gserviceaccount.com`) với quyền **Editor**.

### 2. Vercel

1. Đẩy repo lên GitHub → Vercel → *Add New Project* → import repo. Framework: **Other**. Không cần build command.
2. Settings → Environment Variables (xem `.env.example`):

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ✔ | Client ID ở bước 1.1 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | ✔* | Nội dung file JSON key. *Hoặc dùng cặp `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` |
| `SESSION_SECRET` | ✔ | Chuỗi ngẫu nhiên ≥ 32 ký tự |
| `SHEET_ID` | | Mặc định là sheet Data NSCN |
| `ALLOWED_DOMAIN` | | VD `nghiason.com.vn` |
| `SESSION_HOURS` | | Mặc định 12 |
| `MAX_BACKDATE_DAYS` | | Mặc định 7 |

3. Deploy. Camera chỉ chạy trên HTTPS, và Vercel đã có sẵn HTTPS.

## Cấu trúc

```
public/                 giao diện (HTML/CSS/JS thuần)
  vendor/html5-qrcode.min.js   thư viện quét QR 2.3.8 (Apache-2.0), lưu cục bộ
api/
  auth.js               GET: phiên hiện tại · POST: đăng nhập Google · DELETE: đăng xuất
  scan.js               GET ?code=…: thông tin + công đoạn của tổ + pallet + nhật ký
  output.js             POST: nhập sản lượng (add) / huỷ dòng (cancel)
  pallet.js             POST: đóng / mở lại pallet
  _lib/                 google.js (Sheets API), data.js (cache + quyền), session.js, domain.js, util.js
test/                   test tích hợp với Google giả lập
```

Cache trong function: danh mục 2–10 phút, Pallet/Pallet Log 10 giây. Trước mỗi lần ghi, app luôn đọc lại Pallet và Pallet Log mới nhất.

## Test

```
node --test test/*.test.js
```

Cần Node.js 20 trở lên. Test giả lập Google, không đụng vào Sheet thật.
