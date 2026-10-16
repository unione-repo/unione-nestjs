import {
  BadRequestException, Controller, Get, HttpCode, Inject, Injectable, Module, Post, Req, UnauthorizedException,
} from "@nestjs/common";
import { UniOneClient } from "unione";
import { createClient, resolveOptions } from "./options.js";
import { UniOneTransport } from "./transport.js";
import { handleWebhook } from "./webhook.js";

/** Injection token of the options given to forRoot() / forRootAsync(). */
export const UNIONE_OPTIONS = "UNIONE_OPTIONS";
/** Injection token of the API client (the client is injectable by its class UniOneClient too). */
export const UNIONE_CLIENT = "UNIONE_CLIENT";

/**
 * Handlers of the webhook notifications, register them in a service:
 *
 *     constructor(webhooks) { webhooks.onEvent(async (event, user) => ...); }
 */
export class UniOneWebhooks {
  constructor() {
    this.notificationHandlers = [];
    this.eventHandlers = [];
  }

  /** @param {(callback: object, payload: object, request: any) => any} handler the whole notification */
  onNotification(handler) {
    this.notificationHandlers.push(handler);
    return this;
  }

  /** @param {(event: object, user: object, request: any) => any} handler each event with its user/project */
  onEvent(handler) {
    this.eventHandlers.push(handler);
    return this;
  }

  /** @returns {import("./webhook.js").WebhookHandlers} */
  handlers(options = {}) {
    return {
      onNotification: async (...args) => {
        await options.onNotification?.(...args);
        for (const handler of this.notificationHandlers) {
          await handler(...args);
        }
      },
      onEvent: async (...args) => {
        await options.onEvent?.(...args);
        for (const handler of this.eventHandlers) {
          await handler(...args);
        }
      },
    };
  }
}
Injectable()(UniOneWebhooks);

function method(cls, name, ...decorators) {
  const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, name);
  for (const decorator of decorators) {
    decorator(cls.prototype, name, descriptor);
  }
}

/**
 * Webhook controller at `path`: GET/HEAD -> 200 (URL check of webhook/set), POST -> signature check (401 when
 * wrong) and the handlers. Needs the raw body: NestFactory.create(AppModule, { rawBody: true }).
 */
function webhookController(path) {
  class WebhookController {
    constructor(options, webhooks) {
      this.options = options ?? {};
      this.key = resolveOptions(this.options).webhookKey;
      this.webhooks = webhooks;
    }

    check() {
      return "OK";
    }

    async receive(request) {
      const body = request.rawBody ?? (Buffer.isBuffer(request.body) || typeof request.body === "string"
        ? request.body : undefined);
      const { status, text } = await handleWebhook(body, this.key, this.webhooks.handlers(this.options), request);
      if (status === 401) {
        throw new UnauthorizedException(text);
      }
      if (status !== 200) {
        throw new BadRequestException(text);
      }
      return text;
    }
  }
  Controller(path)(WebhookController);
  Inject(UNIONE_OPTIONS)(WebhookController, undefined, 0);
  Inject(UniOneWebhooks)(WebhookController, undefined, 1);
  method(WebhookController, "check", Get(), HttpCode(200));
  method(WebhookController, "receive", Post(), HttpCode(200));
  Req()(WebhookController.prototype, "receive", 0);
  return WebhookController;
}

/**
 * Global module: UniOneClient (also UNIONE_CLIENT), UniOneWebhooks, UniOneTransport (Nodemailer) and the webhook
 * controller.
 */
export class UniOneModule {
  /**
   * @param {import("./options.js").UniOneOptions & import("./webhook.js").WebhookHandlers & {client?: UniOneClient, webhook?: boolean}} [options]
   *   webhook: false - no webhook controller
   */
  static forRoot(options = {}) {
    return this.build({ provide: UNIONE_OPTIONS, useValue: options }, [], options);
  }

  /**
   * @param {{imports?: any[], inject?: any[], useFactory: (...args: any[]) => object|Promise<object>, webhookPath?: string, webhook?: boolean}} options
   *   webhookPath and webhook are static: the route is known before the factory runs
   */
  static forRootAsync({ imports = [], inject = [], useFactory, ...rest }) {
    return this.build({ provide: UNIONE_OPTIONS, useFactory, inject }, imports, rest);
  }

  static build(optionsProvider, imports, options) {
    const path = resolveOptions({ webhookPath: options.webhookPath }).webhookPath;
    return {
      module: UniOneModule,
      global: true,
      imports,
      controllers: options.webhook === false ? [] : [webhookController(path)],
      providers: [
        optionsProvider,
        UniOneWebhooks,
        { provide: UniOneClient, useFactory: (o) => o?.client ?? createClient(o ?? {}), inject: [UNIONE_OPTIONS] },
        { provide: UNIONE_CLIENT, useExisting: UniOneClient },
        { provide: UniOneTransport, useFactory: (client) => new UniOneTransport({ client }), inject: [UniOneClient] },
      ],
      exports: [UNIONE_OPTIONS, UniOneClient, UNIONE_CLIENT, UniOneWebhooks, UniOneTransport],
    };
  }
}
Module({})(UniOneModule);
