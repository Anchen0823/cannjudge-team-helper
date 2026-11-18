# CANNJudge 团队提交与查榜助手

面向 ICT 决赛十道算子题。把本地工程打成一个版本，在已登录的 Chrome 题目页核对修改并提交。队员也可以单独查本队各题排名和总分，或把连续迭代的任务放进本地队列。

## 第一次使用

准备桌面 Chrome、Python 3.10 或更新版本，以及直接包含 `op_host` 和 `op_kernel` 的题目工程。Python 部分仅使用标准库。在 GitHub 点击 **Code → Download ZIP**，解压后操作。

1. **找到提交记录 ID。** 在同一赛事打开一个你有权查看的提交详情，复制详情记录的 24 位十六进制 ID。可以用队友同赛事另一道题的记录。页面上显示的十进制提交编号用途不同。
2. **生成工程包。** Windows 双击 `start.cmd`，其他系统在解压目录运行 `python3 team.py`。按提示填写题目网址、工程目录、记录 ID、平台账号、队名和版本。向导只在本地生成文件。
3. **安装书签。** 用 Chrome 打开终端最后打印的 `提交入口.html`，按 Ctrl+Shift+B 显示书签栏，把「提交工程包」或「查团队排名」拖入栏中。macOS 使用 ⌘+Shift+B。
4. **提交并保存回执。** 登录 CANNJudge，打开这次打包的题目页，点击「提交工程包」书签，选择刚生成的同目录 `payload.json`。核对题名、版本和差异后点击提交，记下平台提交 ID。需要持续跟进到终态时使用下面的队列模式。
5. **只查排名。** 在已登录的 CANNJudge 页面点「查团队排名」。面板显示账号和队伍匹配到的各题名次、得分与赛事总分，可手动刷新或导出 JSON。关闭面板即停止刷新。

每版生成在独立的 `packages/<题名>/<时间>/` 目录中。下一次只需重新打包并选择新包。查榜书签绑定打包时的账号、队伍和赛事，更换后请更新书签。

## 连续提交与自动收取结果

本地 Python 服务管理队列，Chrome 标签页用当前登录账号向平台发送请求。两者通过你选定的本地目录交换任务和回执。每位队员在自己的电脑和账号下运行。

1. 在助手目录打开终端，运行 `python bridge.py serve` 并保持运行。
2. 用 Chrome 打开 `runtime/后台提交入口.html`，把后台助手拖进书签栏。在已登录的 CANNJudge 题目页点击该书签，选择这个助手目录下的 **runtime/exchange**，允许读写，并保持标签页打开。
3. 新开终端，运行 `python bridge.py status`。看到近期的 `worker: last seen …s ago` 表示已连接。核对当前登录账号后，用下面的命令入队。**入队即授权该标签页自动提交这一包。**

```powershell
python bridge.py enqueue "packages/题名/时间/payload.json"
python bridge.py status
```

| 状态 | 怎么判断或处理 |
| --- | --- |
| `worker: not connected` | 确认服务仍在运行，回到题目页启动后台书签，重新选择本次服务的 exchange 目录。 |
| `queued` | 工程已在本机排队。检查心跳、平台冷却时间及前一个任务状态。 |
| `submitted` | 已取得平台提交 ID，可用它在网站核对进度。 |
| `done` | 已收到终态；查看 Pass、Wrong Answer 或其他平台结果。隐藏点仅显示平台公开的信息。 |
| `posting / uncertain` | 可能已发出请求。先按账号、题目和时间查网站提交记录，再核对本地回执，避免重复发送。 |

队列保留每版哈希、提交 ID、可见测试点和排名快照，位于 `runtime/jobs/`。平台明确返回限流时，助手按等待时间延后。仅需手工提交或只查榜的队员可直接使用首次流程。

## 开发与验证

`team.py` 引导打包，`build.py --help` 提供脚本化参数。`helper.js` 比对在线模板的可编辑文件并提交，`ranking.js` 查询并匹配榜单。`bridge.py` 和 `file_transport.py` 管理本机队列，`filesystem.js` 与 `background.js` 在浏览器中取件并回传评测。登录凭据留在浏览器；生成的工程包包含所选源码，请只选题目工程目录。

在仓库根目录使用 Python 和 Node.js 运行回归：

```sh
python test-bridge.py
node test-helper.cjs
node test-ranking.cjs
node test-background.cjs
```

这些测试使用临时目录和模拟网站响应，不消耗比赛提交次数。
