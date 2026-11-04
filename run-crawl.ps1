# 每日增量抓取（Windows 计划任务调用）
#
# 为什么不再用 run-crawl.bat：
# 1. 原 bat 写死 --natures=2,3，只抓中标公示，不抓招标公告（natures=1）
# 2. 原 bat 没有 --since，靠断点续跑；断点已 finished 时会被自动跳过，静默不抓
# 3. 原计划任务只配了一次性触发（Repetition.Interval 为空），2026-10-24 跑过一次就再没跑
#
# 现在的做法：每次重置断点 + 只回溯最近 N 天。列表按时间倒序，遇到整页早于 since 就停，
# 所以增量任务耗时与数据量无关，只与"最近 N 天有多少条"有关。
#
# 手动补抓更早的数据：把 -Days 调大，例如 -Days 30。

param(
    [int]$Days = 7
)

$ErrorActionPreference = 'Stop'
Set-Location 'd:\project\ah-bid'

$since = (Get-Date).AddDays(-$Days).ToString('yyyy-MM-dd')
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

"=== $stamp 开始增量抓取 since=$since days=$Days ===" | Out-File -Append -Encoding utf8 data\crawl.log

# natures: 1=招标公告 2=中标候选人 3=中标结果。三类都要，否则细则项目查不到公告
node --no-warnings src\crawl.ts --natures=1,2,3 --since=$since --reset=all `
    >> data\crawl.log 2>> data\crawl.err

$code = $LASTEXITCODE

# ---- 附件下载（受磁盘上限保护）----
# 为什么放在这里：原来附件要手动按市跑 attach.ts，新公告的标书永远不会自动下来。
# 现在一次跑完全部城市，只处理最近 2 天、且还没有任何附件记录的公告。
# 限定 attach.ts 默认的四类业务 tag（power/building/pv/storage），不抓全站。
$limitGB = 40
$attachDir = 'data\attachments'
$sizeGB = 0
if (Test-Path $attachDir) {
    $sum = (Get-ChildItem $attachDir -Recurse -File -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
    if ($sum) { $sizeGB = [math]::Round($sum / 1GB, 1) }
}

if ($sizeGB -lt $limitGB) {
    "--- 附件阶段开始（当前 ${sizeGB} GB / 上限 ${limitGB} GB）---" |
        Out-File -Append -Encoding utf8 data\crawl.log
    node --no-warnings src\attach.ts --nature=1 --recent-days=2 --only-missing --limit=200 `
        >> data\crawl.log 2>> data\crawl.err
    "--- 附件阶段结束 exit=$LASTEXITCODE ---" | Out-File -Append -Encoding utf8 data\crawl.log
} else {
    "!!! 附件目录已达 ${sizeGB} GB，超过上限 ${limitGB} GB，本次跳过下载 !!!" |
        Out-File -Append -Encoding utf8 data\crawl.err
}

# 抓完立刻出日报并推送。
# --days=2 而不是 1：跨天边界（凌晨跑时"昨天"的公告也要覆盖）。
# 推送渠道读 data/notify.config.json，没配就只写 output/digest.md，不报错。
node --no-warnings src\daily-digest.ts --days=2 --send >> data\crawl.log 2>> data\crawl.err
$digestCode = $LASTEXITCODE
if ($digestCode -ne 0) { "日报生成/推送失败 exit=$digestCode" | Out-File -Append -Encoding utf8 data\crawl.err }

"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 结束 exit=$code ===" | Out-File -Append -Encoding utf8 data\crawl.log
exit $code
