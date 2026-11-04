"""发一封纯文本邮件，正文从 stdin 读。零依赖（smtplib 是标准库）。

为什么单独一个脚本：Node 没有内置 SMTP，装 nodemailer 违背项目零依赖约定，
而 Python 标准库一行就能发。

用法：
  echo "正文" | python src/send-mail.py --subject "标题" --to a@b.com

环境变量：
  SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
  端口 465 走 SSL，587 走 STARTTLS，其它按 465 处理。
"""

import argparse
import os
import smtplib
import sys
from email.header import Header
from email.mime.text import MIMEText


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", required=True)
    ap.add_argument("--to", required=True)
    args = ap.parse_args()

    host = os.environ.get("SMTP_HOST", "")
    port = int(os.environ.get("SMTP_PORT", "465"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASS", "")

    if not (host and user and password and args.to):
        print("[邮件] 缺少 SMTP_HOST/SMTP_USER/SMTP_PASS 或收件人", file=sys.stderr)
        return 2

    body = sys.stdin.read()
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(args.subject, "utf-8")
    msg["From"] = user
    msg["To"] = args.to

    try:
        if port == 587:
            s = smtplib.SMTP(host, port, timeout=30)
            s.starttls()
        else:
            s = smtplib.SMTP_SSL(host, port, timeout=30)
        s.login(user, password)
        s.sendmail(user, [x.strip() for x in args.to.split(",")], msg.as_string())
        s.quit()
    except Exception as e:
        print(f"[邮件] 发送失败：{type(e).__name__}: {e}", file=sys.stderr)
        return 1

    print(f"[邮件] 已发送至 {args.to}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
