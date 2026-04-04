import crypto from "crypto";
import {
  BaseExecutor,
  mergeUpstreamExtraHeaders,
  type ExecuteInput,
  type ProviderCredentials,
} from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

function getAuthToken(credentials: ProviderCredentials): string {
  if (typeof credentials.apiKey === "string" && credentials.apiKey.trim()) {
    return credentials.apiKey.trim();
  }
  if (typeof credentials.accessToken === "string" && credentials.accessToken.trim()) {
    return credentials.accessToken.trim();
  }
  if (typeof credentials.refreshToken === "string" && credentials.refreshToken.trim()) {
    return credentials.refreshToken.trim();
  }
  return "";
}

function buildCosyHeaders(bodyStr: string, email: string, token: string) {
  const aesKeyBytes = crypto.randomBytes(16);
  const aesKeyStr = aesKeyBytes.toString("hex").slice(0, 16);
  const aesKeyBuf = Buffer.from(aesKeyStr, "utf8");

  const uid = email || "omniroute.user@qoder.sh";
  const name = uid.split("@")[0];

  const userInfo = {
    uid: uid,
    security_oauth_token: token,
    name: name,
    aid: "",
    email: email || uid,
  };

  // AES-128-CBC
  const cipher = crypto.createCipheriv("aes-128-cbc", aesKeyBuf, aesKeyBuf);
  let ciphertext = cipher.update(JSON.stringify(userInfo), "utf8", "base64");
  ciphertext += cipher.final("base64");

  // RSA PKCS1
  const encryptedKeyBuf = crypto.publicEncrypt(
    {
      key: PUBLIC_KEY,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    aesKeyBuf
  );
  const cosyKeyB64 = encryptedKeyBuf.toString("base64");

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadStr = JSON.stringify({
    version: "v1",
    requestId: crypto.randomUUID(),
    info: ciphertext,
    cosyVersion: "0.12.3",
    ideVersion: "",
  });
  const payloadB64 = Buffer.from(payloadStr).toString("base64");

  const sigPath = "/api/v2/service/pro/sse/agent_chat_generation";
  const sigInput = `${payloadB64}\n${cosyKeyB64}\n${timestamp}\n${bodyStr}\n${sigPath}`;
  const sig = crypto.createHash("md5").update(sigInput).digest("hex");

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKeyB64,
    "Cosy-User": uid,
    "Cosy-Date": timestamp,
    "Content-Type": "application/json",
    "X-Request-Id": crypto.randomUUID(),
    "X-Machine-OS": "darwin",
    "X-IDE-Platform": "vscode",
    "X-Version": "0.12.3",
  };
}

export class QoderExecutor extends BaseExecutor {
  constructor() {
    super("qoder", PROVIDERS.qoder);
  }

  async execute({ model, body, stream, credentials, signal, upstreamExtraHeaders }: ExecuteInput) {
    const token = getAuthToken(credentials);

    if (!token) {
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: "Qoder access token or API Key is required. Please sign in or set a PAT.",
              type: "authentication_error",
              code: "token_required",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        ),
        url: "https://api1.qoder.sh",
        headers: { "Content-Type": "application/json" },
        transformedBody: body,
      };
    }

    const email = "";
    const resolvedModel = model || "qoder-rome-30ba3b";

    // Reconstruct body for building prompt
    const originalBody = {
      ...(typeof body === "object" && body !== null ? body : {}),
    };

    // Qoder CLI has a helper to build prompt
    let questionText = "";
    try {
      const { buildQoderPrompt } = require("../services/qoderCli.ts");
      questionText = buildQoderPrompt(originalBody);
    } catch {
      questionText = "Complete the request based on messages.";
    }

    const requestID = crypto.randomUUID();
    const sessionID = crypto.randomUUID();

    const proprietaryReqBody = {
      question: questionText,
      model: resolvedModel,
      stream: true,
      session_id: sessionID,
      request_id: requestID,
    };

    const bodyStr = JSON.stringify(proprietaryReqBody);
    const headers = buildCosyHeaders(bodyStr, email, token);
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);

    const endpoint =
      "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?AgentId=agent_common";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: bodyStr,
        signal,
      });

      const newHeaders = new Headers(response.headers);

      // If Qoder fails, we must read the body. It might be JSON with 'traceId' or HTML.
      if (!response.ok) {
        let errText = await response.text();
        return {
          response: new Response(
            JSON.stringify({
              error: {
                message: `Qoder API failed with status ${response.status}: ${errText}`,
                type: response.status === 401 ? "authentication_error" : "provider_error",
              },
            }),
            { status: response.status, headers: { "Content-Type": "application/json" } }
          ),
          url: endpoint,
          headers: headers as Record<string, string>,
          transformedBody: proprietaryReqBody,
        };
      }

      // We need to parse Qoder's proprietary SSE and emit standard chunks.
      // Qoder returns EventSource chunks but the payload contains {"type":"result", "text": "...", "status": "generating"} or {"type": "chunk", "choices": [{"delta": {"content": "..."}}]}
      // Actually wait, let's wrap the response stream to parse it instead of raw returning it if it's proprietary!
      // In CLIProxyAPI they parse it: if choice, ok := choices[0]; if delta, ok := choice["delta"]
      // So they DO return `choices[0].delta.content` inside Qoder SSE!
      // If they return `choices`, then we don't need a custom parser, the chatCore openAI parser handles it!

      return {
        response: new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        }),
        url: endpoint,
        headers: headers as Record<string, string>,
        transformedBody: proprietaryReqBody,
      };
    } catch (e: any) {
      if (e.name === "AbortError") {
        throw e;
      }
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: `Qoder fetch error: ${e.message}`,
              type: "provider_error",
            },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        ),
        url: endpoint,
        headers: headers as Record<string, string>,
        transformedBody: proprietaryReqBody,
      };
    }
  }
}

export default QoderExecutor;
