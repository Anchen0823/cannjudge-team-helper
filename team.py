"""Interactive package builder. Submission is a separate, explicit action."""
from pathlib import Path
from urllib.parse import urlparse
import re
import subprocess
import sys

from bridge import ALLOWED

ROOT = Path(__file__).resolve().parent


def ask(label, parse):
    while True:
        value = input(label + "\n> ").strip().strip('"')
        try:
            if not value:
                raise ValueError("请填写此项。")
            return parse(value)
        except ValueError as exc:
            print(exc)


def problem(value):
    url = urlparse(value)
    slug = url.path.rstrip("/").split("/")[-1]
    if url.scheme != "https" or url.netloc != "cannjudge.cn" or slug not in ALLOWED or url.path.rstrip("/") != "/public/ictcompetition/" + slug:
        raise ValueError("请复制本届决赛十题之一的题目页网址。")
    return slug


def code_dir(value):
    p = Path(value).expanduser().resolve()
    if not all((p / folder).is_dir() for folder in ("op_host", "op_kernel")):
        raise ValueError("请选择直接包含 op_host 和 op_kernel 的工程目录。")
    return p


def reference(value):
    if not re.fullmatch(r"[a-fA-F0-9]{24}", value):
        raise ValueError("请填写提交详情中的 24 位记录 ID，十进制展示编号不能用于绑定赛事。")
    return value


def main():
    print("CANNJudge 团队打包向导（仅生成本地文件）")
    slug = ask("1. 粘贴题目页网址", problem)
    source = ask("2. 输入或拖入工程目录", code_dir)
    anchor = ask("3. 同一赛事中你可查看的任一提交记录 ID", reference)
    account = ask("4. 查榜用的平台账号名", str)
    team = ask("5. 平台显示的完整队名", str)
    version = ask("6. 本次版本名，例如 v1", str)
    from datetime import datetime
    output = ROOT / "packages" / slug / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "build.py"),
                    "--code", str(source), "--contest-reference", anchor,
                    "--path", "/public/ictcompetition/" + slug, "--title", slug,
                    "--version", version, "--account", account, "--team", team,
                    "--out", str(output)], check=True)
    print("用 Chrome 打开生成的「提交入口.html」。页面会引导你安装提交或查榜书签。")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        sys.exit("打包已取消。")
