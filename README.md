# Plexus

Phần mềm điều phối một nhóm AI (nhiều account Claude Code và Codex) tự phát triển một dự án phần mềm từ documentation tới thành phẩm. Các AI tự đọc tài liệu, tự lập kế hoạch, làm song song, review chéo, kiểm thử, đánh giá theo tiêu chí hoàn thành. Khi một account hết quota, task tự chuyển sang account khác.

- Thiết kế: [docs/01-feasibility-and-architecture.md](docs/01-feasibility-and-architecture.md)
- Kiểm chứng quota: [docs/02-quota-monitoring-feasibility.md](docs/02-quota-monitoring-feasibility.md)
- Cách hệ thống được xây và vận hành: [docs/03-implementation.md](docs/03-implementation.md)

## Yêu cầu

- Node.js ≥ 24 (đã test với 26.8). Không cần cài thêm database: hệ thống dùng `node:sqlite` có sẵn trong Node.
- Git.
- Tuỳ loại account bạn dùng:
  - **Claude Code CLI**: `npm install -g @anthropic-ai/claude-code`
  - **Codex CLI**: `npm install -g @openai/codex`

## Cài đặt

```bash
npm install
```

```bash
npm --prefix ui install
```

```bash
npm run ui:build
```

## Chạy

```bash
npm start
```

Lệnh này chạy daemon và tự mở http://127.0.0.1:4317 (`npm run daemon` chạy daemon mà không mở trình duyệt).

Nếu daemon đang chạy rồi, `npm start` chỉ mở giao diện của daemon đó. Muốn khởi động lại (ví dụ sau khi cập nhật code):

```bash
npm run stop
```

```bash
npm start
```

`npm run stop` dừng daemon an toàn. Task đang chạy được giữ lại và tự chạy tiếp ở lần khởi động sau. Daemon chạy nền độc lập với giao diện: đóng trình duyệt thì Plexus vẫn chạy.

Dữ liệu (database, thư mục đăng nhập của từng account, roles, skills, worktree, log) nằm ở `%APPDATA%\plexus` trên Windows, `~/.plexus` trên macOS/Linux. Đổi vị trí bằng biến `PLEXUS_HOME`, đổi cổng bằng `PLEXUS_PORT`.

## Desktop app (Windows, Linux)

Bản desktop chạy cùng daemon và dữ liệu như trên, kèm icon ở khay hệ thống. Đóng cửa sổ thì Plexus vẫn chạy nền. Chi tiết: [docs/04-desktop-app-feasibility.md](docs/04-desktop-app-feasibility.md).

```bash
npm --prefix desktop install
```

```bash
npm run desktop
```

Lệnh trên chạy app từ mã nguồn. Muốn tạo bộ cài:

- Windows: `npm run desktop:win` → `desktop/release/Plexus Setup <version>.exe`
- Linux (chạy trên máy Linux): `npm run desktop:linux` → `.deb` và `.tar.gz`

Bản cài không cần Node.js (app có Node riêng). Vẫn cần git, Claude Code CLI và/hoặc Codex CLI như mục Yêu cầu.

## Bắt đầu nhanh

1. **Accounts → Add account.** Chọn Claude hoặc Codex. Mỗi account có thư mục đăng nhập riêng, nên thêm được nhiều account cùng loại.
2. Bấm **Log in**. Một cửa sổ terminal mở ra; bạn đăng nhập trên trình duyệt một lần là xong.
3. **＋ New project.** Chọn thư mục chứa documentation (ví dụ `docs/`, `README`, `GOAL.md`), ghi mục tiêu, bấm **Create**.
   - Plexus kiểm tra tài liệu trước. Nếu không có goal và docs, hoặc docs chưa nói rõ cần xây gì, Plexus dừng lại hỏi bạn trong Chat thay vì tự đoán.
   - **How to build**: `Auto` (mặc định) để analyst chọn. Project vừa và nhỏ do **một agent** làm từ đầu tới cuối; chỉ việc lớn, tách được thành nhiều phần độc lập mới chạy theo team song song.
4. Theo dõi tiến độ ở các tab:
   - **Chat**: hỏi tiến độ hoặc đưa chỉ đạo mới cho Plexus. Yêu cầu xây/sửa gì đó trong Chat được Coordinator tự làm như một agent (model của Coordinator), kể cả khi project chưa Start.
   - **Tasks**: bảng công việc.
   - **Activity**: output trực tiếp của các agent.
   - **Memory**: bộ nhớ chung mà mọi agent đọc.
   - **Report**: báo cáo cuối.
5. Plexus sai hướng thì bấm **Pause** hoặc **Stop**, rồi nhắn chỉ đạo trong Chat. Những thay đổi lớn hiện dưới dạng đề xuất để bạn **Approve** trước khi áp dụng.

Kết quả nằm trong chính thư mục project (nhánh `main`). Báo cáo cuối ở `.plexus/REPORT.md`.

## CLI

```bash
node src/cli/plexus.ts help
```

Các lệnh chính:

| Lệnh | Việc |
|---|---|
| `plexus account add claude --id claude-02` | Thêm account |
| `plexus account login claude-02` | Đăng nhập account |
| `plexus accounts` | Xem account và quota |
| `plexus project add <thư mục> --goal "..." --start` | Tạo và chạy project |
| `plexus tasks <project>` | Xem danh sách task |
| `plexus chat <project> "..."` | Nhắn cho Coordinator |
| `plexus watch <project>` | Theo dõi trực tiếp |
| `plexus pause` · `plexus stop` · `plexus resume` | Điều khiển project |

## Kiểm thử

```bash
npm test
```

Có 52 test, gồm:
- Bộ phân loại trạng thái quota của Claude và Codex.
- Chọn account.
- Một project chạy trọn vòng đời bằng agent giả lập (provider `mock`, không tốn quota), có bàn giao khi hết quota và review → sửa → merge.
- Dừng giữa chừng, khởi động lại daemon rồi chạy tiếp.
- Pipeline thích ứng: hỏi trước khi thiếu docs, một agent cho project nhỏ và cho yêu cầu từ Chat, fix sau review tiếp tục phiên của người viết.

```bash
npm run typecheck
```

## Lưu ý an toàn

- Để tự chạy hoàn toàn, agent được chạy ở chế độ **không hỏi quyền**: `--dangerously-skip-permissions` cho Claude và `--dangerously-bypass-approvals-and-sandbox` cho Codex.
  - Mỗi task chỉ làm việc trong git worktree riêng.
  - Dù vậy, nên chạy daemon trong WSL2/Docker hoặc trên máy không chứa dữ liệu quan trọng.
- Skill cài từ bên ngoài được để **tắt** cho tới khi bạn xem hết file của nó (Skills → Review files).
- API chỉ nghe trên `127.0.0.1` và yêu cầu token, lưu tại `<PLEXUS_HOME>/api-token`.
- Dùng nhiều account để cộng dồn quota có thể vi phạm điều khoản của nhà cung cấp. Xem mục 10 trong tài liệu thiết kế.
