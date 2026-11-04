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
"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 结束 exit=$code ===" | Out-File -Append -Encoding utf8 data\crawl.log
exit $code
