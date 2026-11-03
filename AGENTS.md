# AGENTS.md

ah-bid：安徽省招投标数据底座 + 技术标材料生成器。功能、命令与数据表见 `USAGE.md`。

本文件是 Agent 在本仓库内执行命令时必须遵守的约束，优先级高于临场判断。

## R1 · 重任务前先做资源预检

**触发范围**：任何可能吃内存或写大盘的操作——

- Python 脚本（PDF/Excel 解析、OCR、全量入库）
- Node 批量任务（`--all`、全量重建、大范围抓取）
- 解压 / 批量导出 / 批量下载
- 生成或合并大文件（> 500 MB）

**三步流程**

1. **探**：先跑一键探测

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\resource-preflight.ps1
   ```

   要看某个目录体积时加 `-Path`（大目录递归较慢，先小范围试）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\resource-preflight.ps1 -Path data\attachments
   ```

2. **估**：按输入规模推峰值，写明口径，不许含糊

   | 输入类型 | 内存峰值 ≈ 输入体积 × | 说明 |
   |---|---|---|
   | 文本 / JSON / CSV | 3–10 | `json.load` 一次性解析取上限 |
   | Excel | 10–30 | 含样式与单元格对象；`read_only=True` 可降到 2–3 倍 |
   | PDF（PyMuPDF 逐页） | 每页 ≈ 20–80 MB | 按页处理可视为常数，与文件总量无关 |
   | 解压 / 压缩包 | 1.5–3 | 另按解压后体积计磁盘写入 |

   磁盘写入按「产出 + 中间文件」估算，中间文件按 2 倍冗余计。

3. **判**：

   - 内存峰值 > **可用内存 50%**，或单次磁盘写入 > **剩余空间 20% 且 > 5 GB** → 高负荷
   - 高负荷 → **先报告后执行**（模板见 R3），未确认不得开跑
   - 非高负荷 → 可执行，但实现方式优先选 R2

## R2 · 低资源实现优先级

能用流式就不用全量：

- **pandas**：`chunksize=` 分块，`usecols` / `dtype` 收窄，避免 `read_excel` 读整本
- **openpyxl**：`load_workbook(read_only=True, data_only=True)`，用完 `wb.close()`
- **xlrd**：迭代行取所需列，不保留 cell 对象
- **JSON**：大文件用 `jsonl` 逐行或 `ijson`，不要 `json.load` 整份
- **SQLite**：`executemany` + 显式事务，禁止逐条 `commit`；先插入后建索引
- **子进程 / 并发**：默认单进程；必须并发时上限 2，且不同时读同一大文件
- **解压**：先只读目录列表，按需单个解压，处理完即删

## R3 · 高负荷告知模板

```
【资源预检】本次任务预估高负荷，请确认后再跑
- 本机：可用内存 X GB / Y GB，工作盘剩余 Z GB
- 任务：<脚本> <参数>，输入 <文件/表> <体积>
- 预估：内存峰值 ≈ A GB（占可用 B%）；磁盘写入 ≈ C GB
- 风险：<OOM / 磁盘写满 / 长时间占用>
- 备选：<流式或分块方案，内存降到 D GB，代价：慢 N 倍 / 需改代码>
- 结论：等你确认，或直接改用备选方案
```

## R4 · 禁止

- 未探测就启动全量解析 / 批量解压 / 大目录递归读写
- 报告里隐去预估量级，只说「可能比较慢」
- 用「先跑跑看，不行再优化」代替预估
