# 多 QQ bot（2.0）

一份配置里可以写多个 QQ bot；同一台机器上每个 pi 进程启动时，按配置顺序找**第一个没上线的**
bot 接入，抢不到的进程待命并每 5 秒重扫。进程退出（或崩溃导致的锁心跳超时）后，该 bot 下线，
待命进程接管。

## 配置

### 多 bot（v2）

```jsonc
// ~/.pi/agent/pi-qqbot.json
{
  "qqbots": [
    { "name": "work", "appId": "1903340143", "appSecret": "……", "sandbox": true },
    { "name": "home", "appId": "1020123456", "appSecret": "……", "sandbox": false }
  ],

  // 以下是全局默认值，qqbots 里可以逐键覆盖
  "queue": { "max": 20, "ack": true },
  "progress": { "enabled": true, "intervalMs": 15000 }
}
```

- **顺序就是抢占顺序**：先起的进程拿 `work`，第二个进程拿 `home`，第三个进程抢不到就待命。
- `name` 缺省为 `bot-<appId 后 6 位>`；日志、`/status`、接管提示都用它。
- `name` 或 `appId` 重复、凭据缺失 → 该条被跳过并写日志，其余照常可用（不会双连接同一个 bot）。
- 同时写顶层 `appId` 和 `qqbots` → 报错，插件不接入（歧义不猜）。

### 单 bot（v1，原格式，无需改动）

```json
{ "appId": "1903340143", "appSecret": "……", "sandbox": true }
```

等价于只有一个名叫 `default` 的 bot，行为与 1.x 完全一致。凭据也仍可来自
`PI_QQBOT_APPID` / `PI_QQBOT_APPSECRET` 环境变量（只用于单 bot 场景；`QQ_BOT_*` 为 2.8 起的弃用别名）。

## 实例身份

| 场景 | 表现 |
|---|---|
| 首次接入 | 日志 `[lock] 接入 qqbot "work" (1903340143) · cwd=E:\Projects\foo · pid=1234`；QQ 首条回执前加「（已接入 qqbot「work」）」；`/status` 显示 `bot: work (…0143) · cwd: …` |
| 换进程接管 | 日志记录新旧 pid 与新旧 cwd；QQ 首条回执前加「（qqbot「work」已由新实例接管 · 当前工作目录 E:\Projects\foo）」 |
| 全部在线 | 日志 `[lock] 无可接入的 qqbot（…），本进程待命，5s 后重扫`；本进程不连 QQ，pi 本身照常用 |
| 会话重建（`/reload`、`/new`、`/fork`、`/resume`） | 释放锁**之前**先写 20 秒预约窗口，其他进程不会趁机抢走；新 runtime 用自己的 pid 认回同一个 bot，静默不打扰 |
| 凭据无效 | 抢到锁后先换一次 `access_token`；失败就**放锁跳过该 bot**（不占槽位），继续试下一个。日志：`[lock] qqbot "x" 凭据不可用：code=100016 invalid appid or secret → 已放锁并跳过该 bot`。全部不可用时不空转重扫 |

`/status` 一眼确认：

```
bot: work (…0143) · cwd: E:\Projects\foo
状态: 空闲
```

> **工作目录与 bot 无绑定。** 分配只看「配置顺序 + 谁在线」，跟 cwd 无关：
> 同一台机器上可以在不同的项目目录各开一个 pi，也可以在一个大工作区（里面好几个项目）里
> 同时开几个 pi——后者照样一人接一个 bot，互不干扰。cwd 只用于日志、接管提示和 `/status` 展示，
> 让你能分辨「现在是哪个实例在管这个 bot」。

## 可选：钉住某个 bot

自动抢占是默认行为。调试或需要「这个目录固定用某个 bot」时，用环境变量钉住：

```powershell
$env:PI_QQBOT_ACCOUNT = "work"; pi
```

钉选时只尝试该账号（可写 name 或 appId）；名字不存在则**不接入**并写日志（不会乱接别的 bot）。

## 能/不能

- **能**：同一台机器上开 N 个 pi，各接一个 bot，互不串话；目录随意（同一目录开多个也成立，目录只是 pi 的工作区）；某个 pi 退出后由待命进程接管。
- **能**：一个 bot 同一时刻只有一个进程连着（锁 + 心跳 + 30 秒僵尸锁回收）。
- **不能**：一个 pi 进程同时服务多个 bot（扩展的 session 是单租户模型）。要多路并行就多开 pi 进程。

## 日志

多 bot 场景下日志按账号分文件：`~/.pi/agent/pi-qqbot-<name>.log`（单 bot 旧格式仍写
`pi-qqbot.log`）。身份记录与锁在 `~/.pi/agent/pi-qqbot-<appId>.lock` / `…owner.json`。

## 排查：某个 bot 一直不上线

1. 看日志：`凭据不可用：code=100016 invalid appid or secret` → appId/secret 写错了
   （可用 `POST https://api.bot.qq.com/app/getAppAccessToken` 自己验一下）；
2. 看日志：`本轮无可接入的 qqbot（x:在线）` → 这个 bot 已被别的 pi 进程连着；
3. 看日志：`被 pid 1234 重载中` → 对方正在 `/reload`，等几秒即可；
4. 什么都没打 → 确认配置能解析（`loadAccounts()` 报错会写 `[setup] 配置问题:`）。
