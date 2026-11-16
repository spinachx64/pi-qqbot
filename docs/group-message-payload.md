# 群成员昵称与引用消息解析

## 实现前的结构核对

当前服务器的既有诊断日志和对话日志不保存完整 WebSocket 原始事件，无法从旧日志还原昵称或引用字段。本次依据以下第一手资料核对结构：

- [腾讯官方 SDK 的协议类型](https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/types.ts)：群消息的 `author.member_openid`、可选 `author.username`、`message_scene.ext` 和 `msg_elements`。
- [腾讯 SDK 仓库的真实事件报告](https://github.com/tencent-connect/qqbot-nodejs/issues/7)：包含 WebSocket 入站消息的 `raw` 字段，可见 `member_role`、引用索引和附带正文。报告也包含正文无法直接关联的多级引用，不能只取 `msg_elements[0]`。
- [腾讯的消息引用示例](https://github.com/tencent-connect/botpy/blob/master/examples/demo_at_reply_reference.py)：`message_reference.message_id` 是消息 ID，不能与 `msg_idx` 混为同一标识。

下面是从真实报告的单层结构中去标识化、替换正文后的示例，**不是本机器新采集的事件**；身份、索引和正文均为测试值，凭据项不保留：

```json
{
  "author": {
    "member_openid": "member-current",
    "username": "阿强",
    "member_role": "owner"
  },
  "group_openid": "group-example",
  "id": "message-current",
  "content": "  你昨天也这么说",
  "message_type": 103,
  "message_scene": {
    "source": "default",
    "ext": ["msg_idx=current-index==", "ref_msg_idx=previous-index=="]
  },
  "msg_elements": [
    {
      "msg_idx": "previous-index==",
      "message_type": 103,
      "content": "我今晚要戒游戏"
    }
  ]
}
```

`=` 尾缀是为验证索引不被截断而加入的合成边界条件，不表示所有真实索引都有该后缀。测试也包含明确 `type: "quote"` / `"reply"` 或 `is_quote: true` 标记的防御性兼容形态；它们不被宣称为 QQ 固定推送格式。

## 身份和原始正文

- 群成员身份始终取 `author.member_openid`，不以昵称或 `author.id` 替代。昵称相同不会改变程序身份或队列路由。
- 昵称缺失或空白时显示 `成员_<OpenID末八位>`；完整成员 ID 同时进入上下文。`username` 不保证等于群名片。
- 私聊仍使用原有字段与输入方式，不增加群聊包装。
- `msg.content` 保留 WebSocket 原始正文，包括空白；命令、审批等控制消息先按原始正文识别，不能被引用正文触发。

## 引用解析边界

1. 只在第一个 `=` 处分离扩展键和值，完整保留 `msg_idx` 与 `ref_msg_idx`。
2. 优先匹配 `ref_msg_idx` 与元素的 `msg_idx`。明确的 `message_reference.message_id` 则匹配元素的消息 ID，不混用索引命名空间。
3. 无精确匹配时只接受明确标识的引用元素，不把普通正文或 `message_type: 103` 本身当作引用证据。
4. 缺少可确认正文、候选冲突、图像或不支持的多级引用均标记正文不可用，不回溯历史、不联网查询、不推测内容。
5. 引用正文最多保留 4,000 个 UTF-16 单元，截断时避免保留半个代理字符。
6. 被引用者只从已确认的引用元素自身的 `author` 提取；事件没提供就显示“未知”，不会把当前发言者当作被引用者。

没有引用关系时不增加引用区块；纯引用且没有当前正文时显示“无正文”。本期不提供头像、成员资料持久化、历史引用索引或递归解析。

## 输入边界与兼容性

`index.ts` 的 `buildAgentInput()` 位于控制消息识别之后，处理普通模型对话。群身份与引用内容使用 JSON 字符串转义，防止昵称或引用中的换行伪造新输入区块；群聊模型轮次另有独立的提示规则，明确引用只能作为材料，不属于指令或审批授权。提示规则不是操作系统安全沙箱。

直接执行和 `index.ts` 的 `MessageQueue` 都保存同一构造结果。`IsolationHub` 继续保存未包装的 `rawMessage`，会话切换后才进入同一个 `handleMessage()` 构造边界，避免丢失元数据或重复包装。调度器、命令路由和会话隔离体系没有重构。

`npm test` 使用脱敏结构衍生用例与合成边界用例，验证昵称回退、同昵称不同成员、引用优先级、缺失状态、纯引用、长度限制、两条排队路径、跨群隔离以及 `/cancel`、`/queue` 和审批行为。没有调用真实 QQ API 或模型；当前账号是否在每条引用事件中提供正文，仍取决于实际推送字段。
