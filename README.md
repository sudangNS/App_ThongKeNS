# Thống kê NS – Quét QR & nhập sản lượng

Web app chạy trên **Vercel**. Công nhân/thống kê tổ quét QR trên phiếu pallet → xem thông tin **chi tiết, cụm, sản phẩm**
→ chọn pallet → nhập sản lượng cho **1 hoặc nhiều công đoạn của chi tiết đó tại tổ đó** trong 1 lần lưu.

Dữ liệu: Google Sheet `Data NSCN` (`1VVW7Zrdw-KmO2HLIh1nchKE8DRGWDtd2hCrS-e_aKUU`).
Không cần build, không có thư viện npm.

## Mã QR

`<part_ref>-<team_id>`, với `team_id` lấy đúng theo tab **To** (thêm/đổi tổ trong Sheet là app tự hiểu). Ví dụ: `LSX-02-1626-03-W003-T-TC`.
App cũng nhận dạng ngắn `LSX-02-1626-03-W003-TC` và mã công đoạn `mo_route_id` (vd `…-W002-S06`).

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
| Pallet | ✔ | Thêm pallet mới; giao → `status = Chờ nhận`, `closed_at`, `closed_by`; nhận → `Đã nhận`, `received_at`, `received_by` + pallet mới tại tổ nhận (`from_pallet_id`, `qty_in`); trả lại → `Trả lại` + lý do trong `note` |
| Transfer | ✔ | 1 dòng mỗi lần chuyển LSX: `transfer_id, from_part_ref, to_part_ref, bom_line_id, up_to_step, qty, reason, created_by, created_at` |
| Pallet Log | ✔ | 1 dòng / công đoạn / lần lưu: `log_id, pallet_id, mo_route_id, work_date (dd/mm/yyyy), worker, qty, [qty_ng], note, created_by, created_at` |
| Scan | – | 1 dòng mỗi lần quét: `scan_id, mo_route_id, scanned_by, scanned_at` |

- App ghi theo **tên cột ở dòng tiêu đề**, nên thêm hay đổi thứ tự cột không làm lệch dữ liệu. Muốn ghi hàng NG thì thêm cột `qty_ng` vào Pallet Log, ô nhập NG sẽ tự hiện.
- Số đã làm của mỗi công đoạn = max(`MO Routing.qty_done`, tổng `Pallet Log.qty`), cùng quy tắc với báo cáo sản lượng của app cũ. App **không sửa** MO Routing.
- **Huỷ** một dòng nhập sai: app không xoá dòng đó mà ghi thêm 1 dòng âm (`note = "HUỶ <log_id> – tên"`), cùng ngày làm, nên lịch sử vẫn còn và báo cáo tự trừ đúng.
- Chữ người dùng nhập (số pallet, lô, ghi chú…) được ghi dạng text, nên không bị Sheet tự đổi thành ngày hay chạy thành công thức.

## Phân quyền

1. **Đăng nhập Google**: email phải có trong tab **Users** với `active = TRUE`. Nếu đặt `ALLOWED_DOMAIN` thì chỉ nhận email thuộc tên miền đó.
2. **Quyền theo tổ** (tab **To**, nhiều email cách nhau dấu phẩy):
   - **Thống kê** = `thong_ke_emails` (hoặc cột tuỳ chọn `Users.teams`, VD `SC, TC`): nhập sản lượng, chuyển LSX.
   - **Tổ trưởng** = `manager_email` (`Users.role = Tổ trưởng`): quét chỉ xem thông tin (không có khung nhập), **Giao** pallet của tổ mình, **Nhận / Trả lại** pallet giao tới tổ mình.
   - `role` bắt đầu bằng *Admin, Quản trị, Kỹ thuật, Quản đốc, Quản lý, Giám đốc*: mọi quyền ở mọi tổ (giao/nhận thay khi tổ trưởng vắng, mở lại pallet, huỷ dòng của người khác).
   - `role = Xem`: chỉ xem.
3. Khoá người dùng bằng cách đặt `active = FALSE`, có tác dụng sau tối đa khoảng 1 phút.
4. Người nhập được tự huỷ dòng của mình **trong ngày**. Quá ngày thì quản lý huỷ.
5. Ngày làm không được ở tương lai. Người không phải quản lý chỉ được nhập lùi tối đa `MAX_BACKDATE_DAYS` ngày (mặc định 7).

## Giao nhận, Trên chuyền, Sản lượng, Chuyển LSX

Tab dưới đáy: **Quét · Việc · Trên chuyền · Sản lượng · Thêm**. Giao diện chọn ở tab Thêm: Theo máy / Sáng / Tối (nhớ theo từng máy).

- **Màn chi tiết sau khi quét**: tổng quan (LSX, SP, cụm, kích thước, nguyên liệu, SL nhận vào / đang làm / đã giao) → cụm, SP (thu gọn)
  → Pallet đang làm → Pallet đã giao → nút **Nhập sản lượng** (pop-up 3 bước: chọn pallet / pallet mới → nhập song song → xác nhận).
  Lỗi chặn lưu; cảnh báo phải tick "đã kiểm tra"; server kiểm tra lại.
- **Nhập nhảy cóc**: công đoạn trong tổ bị bỏ trống mà công đoạn sau (trên cùng pallet) nhiều hơn → hỏi có ghi bù không.
  Đồng ý → thêm dòng Pallet Log cho công đoạn bị bỏ qua (`note = "Bù CĐ bỏ qua"`), SL = phần thiếu. Công đoạn đã nhập nhưng ít hơn thì không tự sửa, chỉ cảnh báo.

- **Vòng đời pallet**: thống kê tổ A nhập SL (*Đang làm*) → tổ trưởng A **Giao** (*Chờ nhận*, khoá nhập) →
  tổ trưởng tổ sau **Nhận đủ** (*Đã nhận*, tạo pallet cùng số tại tổ sau) hoặc **Trả lại** + lý do (*Trả lại*, về tổ A sửa rồi giao lại).
  Không sửa SL khi nhận. Giao tới = tổ của công đoạn kế; chi tiết xong tổ cuối → tổ của bước đầu cụm/SP cha (thường Lắp ráp, không tạo pallet mới).
  SL giao = SL của pallet ở bước cuối của tổ. SP xong đóng gói → **Hoàn thành pallet**.
- **Chuông**: số pallet đang chờ tổ mình nhận (cập nhật mỗi 60 giây khi app mở). Bấm → tab Việc.
- **Trên chuyền** (tính theo SL như app Thong_Ke_NSCN, không phụ thuộc trạng thái pallet): tồn = SL công đoạn trước đã xong − SL công đoạn sau đã làm.
  Khác tổ → *Chờ làm* ở đầu vào tổ sau (gồm hàng đã nhận nhưng tổ sau chưa khai báo); cùng tổ → *đang làm dở*; xong bước cuối chi tiết/cụm → *Chờ ráp* ở tổ ráp.
  Phần trên pallet chưa giao / đã giao chưa nhận vẫn tính ở tổ giao. Lọc tổ; tổng m³ gỗ, chi tiết/cụm/SP; tuổi tồn FIFO, cảnh báo ≥ 3 ngày.
- **Sản lượng** ngày/tuần/tháng: cùng quy tắc với app Thong_Ke_NSCN – công đoạn bỏ qua suy ra từ công đoạn sau, cụm/SP đã vào ráp thì chi tiết con tính đã xong;
  SL tổ = SL ở bước cuối của tổ trên từng chi tiết; m³ tinh theo `BOM Wood.m3_finish`; toàn nhà máy = SP xong đóng gói; so với kỳ trước.
- **Chuyển LSX** (thống kê/quản lý): chỉ chi tiết, chỉ giữa 2 LSX cùng `bom_line_id`, SL ≤ số đã ghi ở mọi công đoạn chuyển.
  Ghi tab Transfer + cặp dòng Pallet Log −SL / +SL (`note = "CHUYỂN <id> …"`), không tính vào sản lượng ngày, không huỷ được – hoàn tác bằng chuyển ngược lại.
## Triển khai (làm theo đúng thứ tự)

Vì sao phải theo thứ tự này: OAuth Client ID (bước 3) cần biết địa chỉ app, mà địa chỉ app chỉ có sau khi tạo project trên Vercel (bước 2).
App deploy lần đầu khi chưa có khoá vẫn mở được, chỉ báo *“Máy chủ chưa cấu hình GOOGLE_CLIENT_ID”*. Đó là bình thường.

### Bước 1 – Đưa code lên GitHub ✅ (đã làm)

Repo: `https://github.com/sudangNS/App_ThongKeNS` (nhánh `main`). Mỗi lần push lên `main` sau này, Vercel sẽ tự deploy lại.

### Bước 2 – Project Vercel ✅ (đã làm)

- Project `thongkenghiason` (team `nghia-son`), nối với GitHub `sudangNS/App_ThongKeNS`. **Mỗi lần push lên `main`, Vercel tự deploy bản chính.**
- **APP_URL = `https://thongkenghiason.vercel.app`**. Function chạy ở Singapore (`sin1`).
- Đã đặt sẵn `SESSION_SECRET` và `ALLOWED_DOMAIN`.
- Kiểm tra cấu hình: mở `APP_URL/api/health`. Kết quả chỉ ghi có/không cho từng mục, không lộ giá trị.

### Bước 3 – Google Cloud: tạo OAuth Client ID (cho nút “Đăng nhập Google”)

Đăng nhập <https://console.cloud.google.com> bằng email công ty (`@nghiason.com.vn`).

1. **Tạo project**: bấm ô chọn project ở thanh trên cùng → **New Project**. Đặt tên `ThongKeNS` → **Create**. Sau đó chọn project vừa tạo.
2. **Màn hình đồng ý (consent screen)**: menu ☰ → **APIs & Services → OAuth consent screen** (giao diện mới gọi là **Google Auth Platform**) → **Get started**.
   - App name: `Thống kê NS`. User support email: email của bạn → Next.
   - Audience: **Internal**, để chỉ người có email công ty đăng nhập được → Next.
   - Contact email: email của bạn → Next → tick đồng ý → **Create**.
3. **Tạo Client**: vào **Clients** (hoặc *Credentials → Create credentials → OAuth client ID*).
   - Application type: **Web application**. Name: `ThongKeNS Web`.
   - **Authorized JavaScript origins** → **Add URI** → dán **APP_URL** = `https://thongkenghiason.vercel.app`. Không có dấu `/` ở cuối.
   - *Authorized redirect URIs*: để trống.
   - Bấm **Create** rồi copy **Client ID** (dạng `xxxx.apps.googleusercontent.com`). Từ đây gọi là **CLIENT_ID**.

### Bước 4 – Google Cloud: tạo Service Account (để app đọc/ghi Sheet)

Vẫn trong project `ThongKeNS`:

1. **Bật API**: ☰ → **APIs & Services → Library** → tìm `Google Sheets API` → **Enable**.
2. **Tạo Service Account**: ☰ → **IAM & Admin → Service Accounts** → **Create service account**.
   - Name: `thongke-sheet` → **Create and continue**. Bỏ qua phần cấp role → **Done**.
   - Copy email của nó, dạng `thongke-sheet@thongkens-xxxx.iam.gserviceaccount.com`. Từ đây gọi là **SA_EMAIL**.
3. **Tạo khoá**: bấm vào service account vừa tạo → tab **Keys** → **Add key → Create new key → JSON → Create**.
   Máy sẽ tải về 1 file `.json`. Đây là khoá bí mật: không gửi qua chat, không đưa vào thư mục code.
   > Nếu báo lỗi *“Service account key creation is disabled”*: tổ chức đang bật chính sách chặn tạo khoá.
   > Cần quản trị Google Workspace vào **IAM & Admin → Organization Policies**, tìm `iam.disableServiceAccountKeyCreation`,
   > và tắt chính sách này riêng cho project `ThongKeNS`.
4. **Chia sẻ Sheet**: mở Google Sheet `Data NSCN` → **Share** → dán **SA_EMAIL** → quyền **Editor** → bỏ tick *Notify people* → **Share**.
   > Nếu Google báo không thể chia sẻ ra ngoài tổ chức: quản trị Workspace cần cho phép chia sẻ với email `iam.gserviceaccount.com`.

### Bước 5 – Nhập khoá vào Vercel và deploy lại

1. Vercel → project `thongkenghiason` → **Settings → Environment Variables**. Thêm từng biến, áp cho cả Production và Preview:

   | Key | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | **CLIENT_ID** ở bước 3 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | Mở file `.json` ở bước 4 bằng Notepad, copy **toàn bộ** nội dung rồi dán vào |
   | `SESSION_SECRET` | Chuỗi ngẫu nhiên ≥ 32 ký tự |
   | `ALLOWED_DOMAIN` | `nghiason.com.vn` |

2. **Deployments** → bản deploy mới nhất → nút **⋯** → **Redeploy**. Biến môi trường chỉ có hiệu lực ở lần deploy mới.

### Bước 6 – Cấp quyền người dùng trong Sheet

- Tab **Users**: mỗi người 1 dòng `email | full_name | role | active=TRUE`.
- Tab **To**: điền email thống kê của từng tổ vào cột `thong_ke_emails`, nhiều email cách nhau bằng dấu phẩy.
  (Xem mục *Phân quyền* ở trên.)

### Bước 7 – Kiểm tra

1. Mở **APP_URL** trên điện thoại và đăng nhập Google.
2. Mở `APP_URL/?code=LSX-02-1626-01-W002-SC`, hoặc quét QR trên một phiếu pallet đã in. Phải thấy thông tin Tay ghế / Cụm hông / Zamora Lounge Chair.
3. Nhập thử 1 số lượng nhỏ, kiểm tra trong tab `Pallet Log` có dòng mới, rồi bấm **Huỷ** để trả lại số cũ.

| Thông báo lỗi | Cách xử lý |
|---|---|
| `Máy chủ chưa cấu hình GOOGLE_CLIENT_ID` | Chưa làm bước 5 hoặc chưa Redeploy |
| Nút Google báo `origin_mismatch` / `invalid_client` | **APP_URL** ở bước 3.3 sai (thừa `/`, thiếu `https://`, sai tên) |
| `Service Account chưa được chia sẻ quyền Sheet` | Làm lại bước 4.4 |
| `Email … chưa có trong tab Users` | Làm bước 6 |

### Biến môi trường tuỳ chọn

| Biến | Mặc định |
|---|---|
| `SHEET_ID` | Sheet Data NSCN |
| `SESSION_HOURS` | 12 (giờ phải đăng nhập lại) |
| `MAX_BACKDATE_DAYS` | 7 (số ngày được nhập lùi) |

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
