# porthop 设计说明

## 目标

`porthop` 用于在 WireGuard 的公网 UDP 入口端口不可达时，协调一台 Server 及其多个
Client 切换到新的入口端口。

每个 Client 只有一个 Peer，该 Peer 指向 Server；一个 Server 可以同时服务多个
Client。任意 Client 发现当前端口长时间无法完成 WireGuard 握手后，都可以报告该端口
不可达。Server 收到针对当前端口的报告后决定新端口，并通过 Coordinator 通知所有
Client。由于一个 Client 遇到的网络封锁很可能影响其他 Client，所有 Client 都跟随
Server 切换到最新端口。

Client 与 Server 不依赖 WireGuard 隧道直接协商。双方通过 Coordinator 交换状态，
控制面请求使用一个共享 `TOKEN`。本机端口转发使用原生 nftables，不经过 iptables
兼容层。

## 组件与职责

CLI 使用脚本中的静态 `PROGRAM_VERSION` 标识软件版本。`porthop version` 和
`porthop --version` 均输出程序名及版本号；当前版本为 `0.1.0`。该软件版本独立于
Coordinator API 路径中的协议版本。

### `forward`

`forward` 是不保存业务状态的本机执行器，只负责让指定的一组 UDP 入口端口转发到
目标端口。它不知道 Client、Peer、握手、Coordinator、端口换代或过渡期。

```text
porthop forward set <name> --dport <port> --port <port> [--port <port> ...]
porthop forward get <name>
porthop forward del <name>
porthop forward list
```

`set` 的端口集合采用完整替换语义。相同参数可以重复执行；当本机状态已经一致时，
命令不修改 nftables。

```bash
porthop forward set wg --dport 51820 --port 30001 --port 30002
```

上述命令表示将 UDP 端口 `30001` 和 `30002` 转发到本机 UDP 端口 `51820`。`name`
只能包含字母、数字、下划线、句点和连字符，所有端口都必须位于 `1` 至 `65535`。

`forward` 只管理 `table inet porthop`。表中有一个挂接到 `prerouting` 的 NAT 基础链，
每个名称对应一条由名称的 SHA-256 摘要派生的普通链。入口端口只能属于一个名称；
`set` 遇到其他名称占用请求的入口端口时，会从旧名称接管该端口并按本次请求更新
目标端口。旧名称的其他入口端口保持不变。运行时锁负责串行化本机规则操作。

替换或删除规则后，`forward` 按旧入口端口和目标端口删除对应的 UDP conntrack
条目，避免旧 NAT 映射继续生效。它不会清空整台机器的连接跟踪表。

### Client

Client 是一次性执行的端口跟随和握手检查命令：

```text
porthop client <name> <interface>
               [--env <path>]
               [--stale-after <seconds>]
               [--url <url>] [--token-file <path>]
               [--refresh] [--dry-run] [--verbose]
```

`name` 是 Coordinator Channel 的名称，`interface` 是本机 WireGuard 接口名称，二者
不必相同。每个 Client 接口必须恰好有一个 Peer，该 Peer 就是 Server，因此命令不
接受 `--peer` 参数。例如：

```bash
sudo porthop client home wg0 --stale-after 300 --verbose
```

Client 先通过 `wg show` 读取唯一 Peer 的实际 Endpoint 和最近握手时间：

1. 握手时间未超过阈值且未指定 `--refresh` 时，Client 保持现状并退出，不访问
   Coordinator。
2. 握手超时或指定 `--refresh` 时，Client 从 Coordinator 获取当前公网端口。如果实际
   Endpoint 端口与 Coordinator 端口不同，Client 保留 Endpoint 主机，只通过 `wg set`
   替换端口，然后退出，不报告故障。
3. 两个端口相同且握手正常时，Client 保持现状；两个端口相同且握手超时时，向
   Coordinator 报告实际 Endpoint 端口不可达。

`--stale-after` 默认值为 `300` 秒。最近握手时间为 `0` 表示从未成功握手，直接视为
超时；握手时间晚于当前系统时间时，握手时长按 `0` 秒计算。故障报告始终使用 Peer
实际使用的 Endpoint 端口：

```json
{
  "port": 30001
}
```

Client 支持 IPv4、主机名和带方括号的 IPv6 Endpoint。接口不存在、Peer 数量不是
1、Peer 没有有效 Endpoint、Channel 不存在以及网络或认证错误都会导致命令失败退出。

`--refresh` 强制查询 Coordinator，即使握手正常也会校准 Endpoint。`--dry-run` 会完成
Peer Endpoint、握手和必要的 Coordinator 查询及判断，但不会执行 `wg set` 或写入故障
状态。`--verbose` 将 Coordinator 端口、Peer、实际 Endpoint、握手时长、决策分支以及
跳过或执行的操作写入标准错误。普通结果写入标准输出。

若隧道可能长期没有业务流量，应为 Peer 配置 `PersistentKeepalive`，否则正常的空闲
隧道也可能被误判为握手超时。

### Server

Server 是一次性执行的入口端口协调命令：

```text
porthop server <name> <interface>
               [--env <path>]
               [--url <url>] [--token-file <path>]
               [--dry-run] [--verbose]
```

`name` 是 Coordinator Channel 和 `forward` 转发组的名称，`interface` 是实际的
WireGuard 接口名称，二者不必相同。例如：

```bash
sudo porthop server home wg0 --verbose
```

Server 通过 `wg show <interface> listen-port` 获取 WireGuard 监听端口，并把它作为
`forward set` 的 `--dport`。命令不接受手工指定的 `--dport`，避免参数与 WireGuard
运行状态不一致。接口不存在、未运行或监听端口无效时，命令失败退出。

Server 先读取 Coordinator 的完整状态，再读取本机转发状态，并按以下分支处理：

1. Coordinator 中没有该 Channel：生成一个可用公网端口，创建或替换本机转发，发布
   新端口，然后退出。只有 `404 Not Found` 表示 Channel 不存在；网络、认证和服务
   错误都必须失败退出。
2. `port != failed_port`：当前端口没有被报告故障。Server 以 Coordinator 的 `port`
   为准检查本机转发；转发组不存在、目标端口不符、当前端口未开放或残留其他入口端口
   时，执行 `forward set` 将规则校准为唯一的当前端口，随后把当前端口写回 Coordinator；
   本机转发已经一致时不重复写入 Coordinator。完成后退出。
3. `port == failed_port`：当前端口被报告故障。Server 生成一个不同的新公网端口，先
   通过 `forward set` 同时开放旧端口和新端口，再把新端口发布到 Coordinator，然后
   退出。

下一次执行时，Coordinator 中的新 `port` 与旧 `failed_port` 不同，Server 进入校准
分支并删除旧入口端口。因此，Server 的执行周期就是旧端口的宽限期。

公网端口默认从 `20000` 至 `59999` 中随机选择，并排除本机其他转发组已经占用的端口、
当前端口和故障端口。若 Coordinator 指定的端口仍由本机的旧名称占用，最终由
`forward set` 接管并校准该端口。

`--dry-run` 会执行 WireGuard、本机转发和 Coordinator 的全部只读查询，完成状态判断
并选择候选端口，但不会调用 `forward set` 或写入 Coordinator。`--verbose` 将接口
查询、Coordinator 状态、本机转发状态、决策分支、候选端口和跳过或执行的操作写入
标准错误。普通结果写入标准输出。

Server 可以服务多个 Client，但所有 Client 共享同一个当前公网入口端口。任意 Client
报告当前端口不可达，都会触发整个服务切换端口。

### Coordinator

Coordinator 是 Client 与 Server 均可访问的控制面，不转发 WireGuard 流量。每个名称
保存 Server 当前使用的端口和 Client 最近报告的故障端口：

```text
name
port
updated_at
failed_port
failed_at
```

对应的 D1 表结构为：

```sql
CREATE TABLE channels (
    name TEXT PRIMARY KEY,
    port INTEGER CHECK (port BETWEEN 1 AND 65535),
    updated_at INTEGER,
    failed_port INTEGER CHECK (failed_port BETWEEN 1 AND 65535),
    failed_at INTEGER
);
```

`port` 是 Server 写入的当前端口，`updated_at` 是该端口的最近写入时间，不作为 Server
心跳或在线状态；
`failed_port` 是 Client 最近报告不可达的端口，`failed_at` 是该报告的时间。时间均为
Unix 时间戳，单位为秒。Server 始终以 `port` 记录自己实际使用并向 Client 发布的
端口。

Coordinator 不区分 Client 和 Server 权限。所有请求使用同一个 `TOKEN`，组件之间的
职责边界由程序约定。状态在进程重启后仍然存在。

Coordinator 不判断故障报告是否针对当前端口，也不保存端口代数、请求编号、应用
确认、Client 标识或独立修订号。当前端口本身就是状态版本，也直接用作 HTTP
`ETag`。Client 只需比较 Coordinator 返回的端口和本地 Endpoint 端口。

### `coordinator`

`coordinator` 是 Coordinator API 的命令行客户端，用于管理 Channel 状态：

```text
porthop coordinator set <name> --port <port> [<options>]
porthop coordinator fail <name> --port <port> [<options>]
porthop coordinator get <name> [<options>]
porthop coordinator del <name> [<options>]
porthop coordinator list [<options>]
```

通用选项为：

```text
--env <path>  --url <url>  --token-file <path>  --json  --verbose
```

`set` 创建 Channel 或更新当前端口，`fail` 写入故障端口，`get` 查询一个 Channel，
`del` 删除整个 Channel，`list` 列出所有 Channel。普通输出示例如下：

```text
wg: port 31001, failed 30001
backup: port 32001, failed -
```

### CLI 环境变量文件

`server`、`client` 和 `coordinator` 支持通过 `--env <path>` 加载环境变量文件。未
指定该选项时，默认加载 `/etc/porthop.env`；默认文件不存在时忽略，显式指定的文件
不存在或无法读取时失败。脚本使用 Bash 的 `source` 执行文件，支持引号、变量展开及
其他 Bash 语法，因此只应加载可信文件。

Channel 名称和 WireGuard 接口名称始终是 `server` 与 `client` 的必填位置参数，不能
通过共享的环境变量文件设置。同一台机器因此可以针对多个接口分别执行命令。
`PORTHOP_STALE_AFTER` 设置 Client 的握手超时秒数。命令行参数优先于加载后的环境
变量。

默认 Coordinator 地址为 `https://porthop.erning.workers.dev`。地址读取顺序为
`--url`、`PORTHOP_URL`、默认地址；令牌读取顺序为 `--token-file`、
`PORTHOP_TOKEN_FILE`、`PORTHOP_TOKEN`。命令行不接受令牌原文，避免令牌进入 Shell
历史和进程参数。

## Coordinator API

所有 API 都使用同一个 Bearer Token：

```http
Authorization: Bearer <token>
```

接口如下：

```text
GET /v1/channels
GET /v1/channels/<name>
PUT /v1/channels/<name>
DELETE /v1/channels/<name>
GET /v1/channels/<name>/failure
PUT /v1/channels/<name>/failure
```

所有状态响应都使用 `Cache-Control: no-store`。`name` 的格式与 `forward` 相同。

### 列出名称

`GET /v1/channels` 返回所有 Channel 的完整状态，并按名称排序：

```json
{
  "channels": [
    {
      "name": "backup",
      "port": 32001,
      "updated_at": 1787800200,
      "failed_port": null,
      "failed_at": null
    },
    {
      "name": "wg",
      "port": 31001,
      "updated_at": 1787800000,
      "failed_port": 30001,
      "failed_at": 1787800100
    }
  ]
}
```

### 获取当前端口

`GET /v1/channels/<name>` 返回 Server 发布的当前入口端口：

```http
HTTP/1.1 200 OK
ETag: "31001"
```

```json
{
  "name": "wg",
  "port": 31001,
  "updated_at": 1787800000,
  "failed_port": 30001,
  "failed_at": 1787800100
}
```

Client 可以在后续轮询中发送 `If-None-Match: "31001"`。如果当前端口仍为 `31001`，
Coordinator 返回 `304 Not Modified`；端口变化时返回 `200 OK`、新的状态和以新端口
为值的 `ETag`。名称尚未初始化时返回 `404 Not Found`。

端口可能在较长时间后被再次使用。Client 即使错过中间变化，只要本地 Endpoint 端口
与当前端口相同，就不需要执行切换，因此不需要独立修订号。Server 应避免短期复用
近期端口，以防延迟到达的旧故障报告产生歧义。

### 发布当前端口

Server 通过 `PUT /v1/channels/<name>` 发布当前端口：

```json
{
  "port": 32001
}
```

Coordinator 创建或覆盖该名称的 `port` 和 `updated_at`，保留已有的 `failed_port` 和
`failed_at`，然后返回：

```http
HTTP/1.1 200 OK
ETag: "32001"
```

```json
{
  "name": "wg",
  "port": 32001,
  "updated_at": 1787800110,
  "failed_port": 31001,
  "failed_at": 1787800100
}
```

首次 `PUT` 负责初始化名称，不需要单独的创建接口、条件请求或应用确认接口。Server
启动、恢复或切换端口时，都要把自己实际使用的端口写入 `port`。Server 必须先成功
应用本机转发规则，再发布当前端口。

### 报告端口不可达

Client 通过 `PUT /v1/channels/<name>/failure` 报告自己正在使用的端口不可达：

```json
{
  "port": 31001
}
```

Coordinator 不比较报告端口和当前端口，直接用报告内容覆盖 `failed_port` 和
`failed_at`，然后返回 Channel 的完整状态：

```json
{
  "name": "wg",
  "port": 31001,
  "updated_at": 1787800000,
  "failed_port": 31001,
  "failed_at": 1787800100
}
```

多个 Client 的报告共用这一组字段，后到的报告覆盖先到的报告，不建立事件队列。
报告是否仍然有效由 Server 比较 `port` 和 `failed_port` 后决定。

### 获取故障状态

Server 通过 `GET /v1/channels/<name>/failure` 获取待处理故障。存在故障时返回：

```json
{
  "failed_port": 31001,
  "failed_at": 1787800100
}
```

尚未收到过故障报告时返回 `204 No Content`。Server 发布新端口时不清除故障字段；
新 `port` 与旧 `failed_port` 不同，本身就表示该故障已经处理。

Server 对两个字段的解释如下：

```text
port == failed_port  当前端口被报告故障，需要切换
port != failed_port  故障不针对当前端口，保持现状
```

Server 选择新端口时，必须保证新端口与 `port` 和 `failed_port` 都不同。写入新端口后，
`port` 与 `failed_port` 恢复为不同值。

### 删除 Channel

`DELETE /v1/channels/<name>` 删除指定 Channel 的全部状态。删除成功时返回
`204 No Content`，名称不存在时返回 `404 Not Found`。

## 端口切换流程

假设当前公网入口端口为 `30001`：

```text
Client A             Coordinator              Server                 forward
   |                      |                       |                       |
   |-- 30001 不可达 ----->|                       |                       |
   |                      |<-- 拉取故障报告 ------|                       |
   |                      |                       |-- 设置 30001+31001 -->|
   |                      |<-- 发布当前端口 31001 |                       |
   |<-- 拉取到 31001 -----|                       |                       |
   |-- 更新 Endpoint      |                       |                       |
   |==== 在 31001 上恢复 WireGuard 握手 =================================>|
   |                      |                       |-- 仅保留 31001 ------>|
```

Server 必须先应用转发规则，再发布新端口。这样，任何 Client 只要从 Coordinator 看到
新端口，就可以立即切换，无须等待额外的应用确认。

切换期间由 Server 计算传给 `forward` 的最终端口集合。例如：

```bash
# 过渡期：同时开放旧端口和新端口
porthop forward set wg --dport 51820 --port 30001 --port 31001

# 宽限期结束：只保留新端口
porthop forward set wg --dport 51820 --port 31001
```

上一代、当前一代和宽限期都属于 Server 的业务逻辑，`forward` 本身不保存这些概念。

## 多 Client 与并发报告

多个 Client 可能几乎同时报告同一个端口不可达：

```text
Client A 报告 30001 ─┐
Client B 报告 30001 ─┼─> Server 只切换一次：30001 → 31001
Client C 报告 30001 ─┘
```

Server 处理报告时必须再次比较报告端口和当前端口：

- 二者相同：报告仍然有效，可以触发端口切换；
- 二者不同：Server 已经切换过端口，忽略该报告。

因此，第一个有效报告触发 `30001` 到 `31001` 的切换；其余针对 `30001` 的报告在
当前端口变为 `31001` 后自然失效，不会造成连续换端口。Server 还应设置合理的切换
冷却时间，以处理 Coordinator 重复投递以及异常 Client 高频报告。

没有报告故障的 Client 也会在下一次拉取时看到 `31001`，并一起更新 Endpoint。各
Client 的轮询时刻不必一致，Server 在宽限期内同时开放新旧端口，以容纳切换时间差。

## 启动与恢复

Server 启动时从 Coordinator 读取当前端口，先调用 `forward set` 恢复本机规则，再
开始处理故障报告。若 Coordinator 尚无当前端口，则由 Server 生成初始端口，应用
本机规则后再发布。

Client 启动时读取 Coordinator 的当前端口，并使本地 Peer Endpoint 与其一致。Client
不需要恢复未完成的故障请求；Coordinator 保存最近一次故障报告，Server 根据端口
是否相等判断是否需要处理。

脚本不启用 `nftables.service`，也不写入系统持久化规则文件。系统重启后，由 Server
进程根据 Coordinator 状态恢复规则。

## 安全性

控制面使用一个共享 `TOKEN` 验证所有请求，不区分 Client 与 Server 权限。这一取舍
以个人部署时的配置简单为优先；持有令牌的组件能够调用全部 API，因此令牌必须妥善
保存，日志不得输出令牌。

Coordinator 应限制故障报告的频率和大小。Server 应校验 Coordinator 返回的端口，
并在调用 `forward` 前检查端口范围及近期使用记录。

## 权限与运行环境

`forward` 和 Server 需要 root 权限，以及 `nft`、`flock` 和 `sha256sum`；安装了
`conntrack` 时，`forward` 会在规则变化后清理对应的 UDP 连接跟踪条目。Client 的
执行用户必须有权读取和修改 WireGuard 接口。访问 Coordinator 的组件还需要 HTTP
客户端。Server 还需要 `wg` 和 `hexdump`，分别用于查询 WireGuard 监听端口和生成
随机公网端口。

## 退出状态

- `0`：命令成功。
- `1`：网络、控制面、nftables 或运行环境错误。
- `2`：命令行参数或配置错误。
