# porthop Coordinator

这是基于 Cloudflare Workers 和 D1 的 `porthop` Coordinator。它保存 Server 当前使用的
公网 UDP 入口端口，以及 Client 最近报告的故障端口。

## 首次部署

安装依赖并登录 Cloudflare：

```bash
npm install
npm run cf:login
```

项目已经绑定名为 `porthop` 的 D1 数据库。检查远端数据库信息：

```bash
npm run db:info
```

应用数据库迁移：

```bash
npm run db:migrate
```

迁移 `0002_replace_channels.sql` 会删除旧版 desired/applied 表及其数据，并创建新版
`channels` 表。

设置共享令牌。可以使用 `openssl rand -hex 32` 生成令牌：

```bash
npm run secret
```

最后部署 Worker：

```bash
npm run deploy
```

当前服务地址为 `https://porthop.erning.workers.dev`。

## 本地开发

复制 `.dev.vars.example` 为 `.dev.vars`，并填写共享令牌。初始化本地 D1 数据库后启动
开发服务器：

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

运行测试：

```bash
npm test
```

## HTTP API

```text
GET /v1/channels
GET /v1/channels/<name>
PUT /v1/channels/<name>
DELETE /v1/channels/<name>
GET /v1/channels/<name>/failure
PUT /v1/channels/<name>/failure
```

除公开的 `GET /` 健康检查外，所有接口都使用同一个令牌：

```http
Authorization: Bearer <token>
```

所有响应均禁止缓存。当前端口响应以端口号作为 `ETag`，并支持
`If-None-Match` 条件请求。

### 列出名称

```http
GET /v1/channels
```

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

### 获取和发布当前端口

```http
GET /v1/channels/wg
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

```http
PUT /v1/channels/wg
Content-Type: application/json
```

```json
{
  "port": 32001
}
```

`PUT` 创建或覆盖当前端口，但保留已有的故障状态。

`DELETE /v1/channels/wg` 删除整个 Channel，成功时返回 `204 No Content`。

### 获取和报告故障端口

```http
PUT /v1/channels/wg/failure
Content-Type: application/json
```

```json
{
  "port": 31001
}
```

`PUT` 返回 Channel 的完整状态。`GET /v1/channels/wg/failure` 只返回故障状态：

```json
{
  "failed_port": 31001,
  "failed_at": 1787800100
}
```

尚未收到故障报告时，`GET` 返回 `204 No Content`。Coordinator 不比较当前端口和
故障端口；Server 根据二者是否相等决定是否切换端口。

## D1 表

```sql
CREATE TABLE channels (
    name TEXT PRIMARY KEY,
    port INTEGER CHECK (port BETWEEN 1 AND 65535),
    updated_at INTEGER,
    failed_port INTEGER CHECK (failed_port BETWEEN 1 AND 65535),
    failed_at INTEGER
);
```

时间字段使用 Unix 时间戳，单位为秒。
