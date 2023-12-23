import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import { ProxyAgent as UndiciProxyAgent } from "undici";
import { Agent, AgentConnectOpts } from "agent-base";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

export function createProxy(opts: { url?: string } = {}) {
  const uri = opts.url || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  if (!uri) {
    return {
      agent: undefined,
      dispatcher: undefined,
    };
  }

  const nodeAgent = new NodeProxyAgent({ uri });

  // https://undici.nodejs.org/#/docs/api/ProxyAgent
  const undiciAgent = new UndiciProxyAgent({ uri });

  return {
    agent: nodeAgent,
    dispatcher: undiciAgent,
  };
}

export function debug(...args: any[]) {
  if (process.env.debug) {
    debug("[node-fetch-native] [proxy]", ...args);
  }
}

// ----------------------------------------------
// HTTP Agent
// ----------------------------------------------

// https://github.com/TooTallNate/proxy-agents/tree/main/packages/proxy-agent

const PROTOCOLS = ["http", "https"] as const;

type ValidProtocol = (typeof PROTOCOLS)[number];
type AgentConstructor = new (...args: never[]) => Agent;

const proxies: {
  [P in ValidProtocol]: [AgentConstructor, AgentConstructor];
} = {
  http: [HttpProxyAgent, HttpsProxyAgent],
  https: [HttpProxyAgent, HttpsProxyAgent],
};

function isValidProtocol(v: string): v is ValidProtocol {
  return (PROTOCOLS as readonly string[]).includes(v);
}

export class NodeProxyAgent extends Agent {
  cache: Map<string, Agent> = new Map();

  httpAgent: http.Agent;
  httpsAgent: http.Agent;

  constructor(private proxyOptions: { uri: string }) {
    super({});
    debug("Creating new ProxyAgent instance: %o", proxyOptions);
    this.httpAgent = new http.Agent({});
    this.httpsAgent = new https.Agent({});
  }

  connect(req: http.ClientRequest, opts: AgentConnectOpts): http.Agent {
    const isWebSocket = req.getHeader("upgrade") === "websocket";

    // prettier-ignore
    const protocol = opts.secureEndpoint
      ? (isWebSocket ? "wss:" : "https:")
      : (isWebSocket ? "ws:" : "http:");

    const host = req.getHeader("host");
    const url = new URL(req.path, `${protocol}//${host}`).href;
    const proxy = this.proxyOptions.uri;

    if (!proxy) {
      debug("Proxy not enabled for URL: %o", url);
      return opts.secureEndpoint ? this.httpsAgent : this.httpAgent;
    }

    debug("Request URL: %o", url);
    debug("Proxy URL: %o", proxy);

    // Attempt to get a cached `http.Agent` instance first
    const cacheKey = `${protocol}+${proxy}`;
    let agent = this.cache.get(cacheKey);
    if (agent) {
      debug("Cache hit for proxy URL: %o", proxy);
    } else {
      const proxyUrl = new URL(proxy);
      const proxyProto = proxyUrl.protocol.replace(":", "");
      if (!isValidProtocol(proxyProto)) {
        throw new Error(`Unsupported protocol for proxy URL: ${proxy}`);
      }
      const Ctor =
        proxies[proxyProto][opts.secureEndpoint || isWebSocket ? 1 : 0];
      // @ts-expect-error meh…
      agent = new Ctor(proxy, this.connectOpts);
      this.cache.set(cacheKey, agent);
    }

    return agent;
  }

  destroy(): void {
    for (const agent of this.cache.values()) {
      agent.destroy();
    }
    super.destroy();
  }
}
