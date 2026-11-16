/** 单会话回复文本累积：message_update 的 text_delta 累加，agent_settled 时取走 */
export class ReplyBuffer {
  private text = "";

  append(delta: string) {
    if (typeof delta === "string") this.text += delta;
  }

  peek(): string {
    return this.text;
  }

  take(): string {
    const t = this.text;
    this.text = "";
    return t;
  }

  reset() {
    this.text = "";
  }
}
