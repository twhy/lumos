import { IdNotMatchException, ResponseException } from "./exceptions";
import { CKBComponents } from "./types/api";
import { RPCConfig } from "./types/common";
import { DEFAULT_RPC_TIMEOUT } from ".";
import AbortController from "abort-controller";
import fetch_ from "cross-fetch";

export class Method {
  #name: string;
  #config: RPCConfig;

  get name(): string {
    return this.#name;
  }

  #options: CKBComponents.Method = {
    name: "",
    method: "",
    paramsFormatters: [],
    resultFormatters: undefined,
  };

  #node: CKBComponents.Node;

  constructor(
    node: CKBComponents.Node,
    options: CKBComponents.Method,
    config: Partial<RPCConfig> = {}
  ) {
    this.#node = node;
    this.#options = options;
    this.#name = options.name;
    const { timeout = DEFAULT_RPC_TIMEOUT, fetch = fetch_ } = config;
    this.#config = { timeout, fetch };

    Object.defineProperty(this.call, "name", {
      value: options.name,
      configurable: false,
      writable: false,
    });
  }

  /* eslint-disable @typescript-eslint/ban-types, @typescript-eslint/explicit-module-boundary-types */
  public call = async (...params: (string | number | object)[]) => {
    const payload = this.getPayload(...params);
    const controller = new AbortController();
    const signal = controller.signal as AbortSignal;

    const timeout = setTimeout(() => controller.abort(), this.#config.timeout);

    const res = await this.#config
      .fetch(this.#node.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      })
      .then((res) => res.json())
      .then((res) => {
        if (res.id !== payload.id) {
          throw new IdNotMatchException(payload.id, res.id);
        }
        if (res.error) {
          throw new ResponseException(JSON.stringify(res.error));
        }
        return this.#options.resultFormatters?.(res.result) ?? res.result;
      });

    clearTimeout(timeout);
    return res;
  };

  public getPayload = (...params: (string | number | object)[]) => {
    const data = params.map(
      (p, i) =>
        (this.#options.paramsFormatters[i] &&
          this.#options.paramsFormatters[i](p)) ||
        p
    );
    /* eslint-disable @typescript-eslint/no-magic-numbers */
    const id = Math.round(Math.random() * 10000);
    const payload = {
      id,
      method: this.#options.method,
      params: data,
      jsonrpc: "2.0",
    };
    return payload;
  };
}
/* eslint-enable @typescript-eslint/ban-types, @typescript-eslint/explicit-module-boundary-types */
