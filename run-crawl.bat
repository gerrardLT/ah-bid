@echo off
rem 由 Windows 任务计划程序调用，独立于任何终端会话。
rem 运行期日志写到 data\crawl.log，异常写到 data\crawl.err。
cd /d d:\project\ah-bid
node --no-warnings src\crawl.ts --natures=2,3 > data\crawl.log 2> data\crawl.err
