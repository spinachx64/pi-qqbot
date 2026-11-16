import { TOKEN_URL } from "../constants";

export class AuthManager {
  private token: string | null = null;
  private expireAt = 0;

  constructor(
    private appId: string,
    private appSecret: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.expireAt - 60_000) return this.token;
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    });
    if (!res.ok) throw new Error(`getAppAccessToken failed: HTTP ${res.status}`);
    const data = (await res.json()) as any;
    const token = String(data.access_token ?? "");
    // QQ 平台对无效凭据返回 HTTP 200 + code 100016，以前只在后面拿空 token 去连网关，
    // 表现为「锁抢到了但永远连不上」；这里直接抛，抢占阶段就能发现。
    if (!token) {
      const code = data?.code ?? "-";
      const message = data?.message ?? data?.msg ?? "未返回 access_token";
      throw new Error(`getAppAccessToken 被拒: code=${code} ${message}`);
    }
    this.token = token;
    this.expireAt = Date.now() + Number(data.expires_in ?? 0) * 1000;
    return this.token;
  }
}
