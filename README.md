# porthop

`porthop` 给 WireGuard 换公网 UDP 入口端口。某个 Client 长时间没有握手时，它会把
当前端口报告给 Coordinator；Server 看到报告后开放一个新端口，其他 Client 随后一起
切换。

它由一个 Bash 脚本和一个 Cloudflare Worker 组成。数据面仍是 WireGuard，公网端口到
WireGuard 监听端口的转发由 nftables 完成。

## 准备工作

Server 需要 Bash、WireGuard 工具、nftables、`flock`、`sha256sum`、`hexdump` 和
`curl`。建议安装 `conntrack`，规则变化时可以顺手清理旧的 UDP 连接跟踪条目。
Client 需要 Bash、WireGuard 工具、`curl`，以及 `jq` 或 OpenWrt 的 `jsonfilter`。

安装脚本：

```bash
sudo install -m 0755 porthop /usr/local/bin/porthop
```

Coordinator 的部署方法见 [worker/README.md](worker/README.md)。部署后，让 Server 和
所有 Client 使用同一个 Token，并分别创建环境变量文件。例如 Client 配置为：

```bash
install -d -m 0700 ~/.config/porthop
printf %s "your-token" > ~/.config/porthop/token
chmod 0600 ~/.config/porthop/token
cat > ~/.config/porthop/client.env <<EOF
PORTHOP_URL=https://porthop.example.com
PORTHOP_TOKEN_FILE=$HOME/.config/porthop/token
PORTHOP_STALE_AFTER=300
EOF
```

## 开始使用

假设 Coordinator 中的 Channel 叫 `home`，Server 和 Client 上的 WireGuard 接口都叫
`wg0`。

在 Server 上执行：

```bash
sudo install -d -m 0700 /etc/porthop
sudo cp ~/.config/porthop/client.env /etc/porthop/server.env
sudo porthop server home wg0 --env /etc/porthop/server.env --verbose
```

Server 环境变量文件使用相同格式，不需要 `PORTHOP_STALE_AFTER`。

第一次运行会选择一个公网端口，建立 nftables 转发，并把端口写入 Coordinator。以后
每次运行都会校准本机规则；如果当前端口被报告故障，就切换到新端口。

在每台 Client 上执行：

```bash
sudo porthop client home wg0 --env /home/user/.config/porthop/client.env --verbose
```

Client 会跟随 Coordinator 中的端口。Endpoint 已经一致时，它才检查最近握手；超过
300 秒没有握手便报告当前端口。可以用 `--stale-after 600` 调整阈值。WireGuard Peer
最好配置 `PersistentKeepalive`，否则一条正常但长期空闲的隧道也会被当成故障。

`server` 和 `client` 都只运行一次，适合放进 systemd timer 或 cron。先用
`--dry-run --verbose` 检查实际决策，不会改规则、Endpoint 或 Coordinator 状态。

## 常用管理命令

```bash
porthop coordinator list
porthop coordinator get home
porthop coordinator set home --port 31001
porthop coordinator fail home --port 31001
porthop coordinator del home
```

直接查看或修改本机转发规则：

```bash
sudo porthop forward list
sudo porthop forward get home
sudo porthop forward set home --dport 51820 --port 31001
sudo porthop forward del home
```

`forward set` 是完整替换：命令里没有列出的旧入口端口会被删除。

## 配置

未指定 `--env` 时，CLI 默认加载 `/etc/porthop.env`；该文件不存在时直接忽略。显式
指定的文件不存在或无法读取时，命令会失败。环境变量文件使用 Bash 的 `source`
加载，因此可以使用引号、变量展开和其他 Bash 语法，也应当只加载可信文件。命令行
参数优先于加载后的环境变量。

CLI 支持以下环境变量：

- `PORTHOP_STALE_AFTER`：Client 判断握手超时的秒数，默认是 `300`。
- `PORTHOP_URL`：Coordinator 地址；默认是
  `https://porthop.erning.workers.dev`。
- `PORTHOP_TOKEN_FILE`：Token 文件路径，推荐使用。
- `PORTHOP_TOKEN`：直接提供 Token。

不使用环境变量文件时，原有调用方式保持不变，例如
`porthop client home wg0 --stale-after 600`。完整协议、状态判断和 D1 表结构见
[DESIGN.md](DESIGN.md)。

## 测试

```bash
bash -n porthop
node --test test/cli.test.mjs

cd worker
npm test
```
