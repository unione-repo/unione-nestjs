import "reflect-metadata";
import assert from "node:assert";
import http from "node:http";
import nodeTest from "node:test";
import { Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import nodemailer from "nodemailer";
import { UniOneClient } from "unione";
import { UNIONE_CLIENT, UniOneModule, UniOneTransport, UniOneWebhooks, signBody } from "../src/index.js";
import { PLATFORM } from "../src/options.js";

const API_KEY = "test-key";
const BASE_PATH = "/en/transactional/api/v1";
const SEND_REPLY = { status: "success", job_id: "1ZymBc-00041N-9X", emails: ["user@example.com"], failed_emails: {} };
const WEBHOOK_BODY = {
  auth: "00000000000000000000000000000000",
  events_by_user: [
    {
      user_id: 1,
      project_id: "6432890213745872",
      events: [
        {
          event_name: "transactional_email_status",
          event_data: {
            job_id: "1a3Q2V-0000OZ-S0",
            email: "user@example.com",
            status: "delivered",
            event_time: "2015-11-30 15:09:42",
          },
        },
        {
          event_name: "transactional_spam_block",
          event_data: {
            block_time: "2015-11-30 15:09:42",
            block_type: "one_smtp",
            domain: "example.com",
            SMTP_blocks_count: 1,
            domain_status: "blocked",
          },
        },
      ],
    },
  ],
};
// WEBHOOK_BODY signed with API_KEY
const WEBHOOK = signBody(JSON.stringify(WEBHOOK_BODY), API_KEY);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Mock of the API on 127.0.0.1: records the calls ({path, platform, key, body}) and answers `api.reply` once
 * ({status, body}), otherwise success (the email/send reply for email/send).
 */
async function mockApi() {
  const api = { calls: [], reply: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const text = Buffer.concat(chunks).toString("utf8");
      const path = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.pathname;
      api.calls.push({
        path,
        platform: url.searchParams.get("platform"),
        key: req.headers["x-api-key"],
        body: text ? JSON.parse(text) : {},
      });
      const success = path === "/email/send.json" ? SEND_REPLY : { status: "success" };
      const reply = api.reply ?? { status: 200, body: success };
      api.reply = null;
      res.writeHead(reply.status, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify(reply.body));
    });
  });
  api.url = (await listen(server)) + BASE_PATH;
  server.unref(); // does not keep the test process alive
  api.close = () => close(server);
  return api;
}

/** No settings of the package from the environment of the machine (no real key, no real host). */
function clearEnv() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("UNIONE_")) {
      delete process.env[name];
    }
  }
}

const api = await mockApi();

/** A test from a clean state: the environment cleared, no calls of the mock. */
function test(name, fn) {
  nodeTest(name, async () => {
    clearEnv();
    api.calls.length = 0;
    api.reply = null;
    await fn();
  });
}

/** Calls fn() with console.warn recorded, returns the warnings. */
async function warnings(fn) {
  const seen = [];
  const warn = console.warn;
  console.warn = (...args) => seen.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return seen;
}

function post(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

/** The platform of the requests: this package, then the SDK. */
function assertPlatform(call) {
  assert.ok(call.platform.startsWith(`${PLATFORM},node-sdk.`), call.platform);
  assert.strictEqual(PLATFORM, "nestjs.1.3.2");
}

/** The test mail through `transporter`: one email/send with the fields of the mail. */
async function checkMail(transporter, api) {
  const info = await transporter.sendMail({
    from: { name: "Shop", address: "shop@example.com" },
    to: { name: "User", address: "user@example.com" },
    subject: "Test",
    text: "Hello",
    html: "<b>Hello</b>",
  });
  assert.strictEqual(info.messageId, "1ZymBc-00041N-9X");
  const sends = api.calls.filter((call) => call.path === "/email/send.json");
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].key, API_KEY);
  assertPlatform(sends[0]);
  assert.deepStrictEqual(sends[0].body.message, {
    recipients: [{ email: "user@example.com", substitutions: { to_name: "User" } }],
    subject: "Test",
    from_email: "shop@example.com",
    from_name: "Shop",
    body: { html: "<b>Hello</b>", plaintext: "Hello" },
  });
}

/** An API error of email/send: sendMail() fails with the ApiError of the SDK. */
async function checkMailError(transporter, api) {
  api.reply = { status: 400, body: { status: "error", message: "Unknown recipient", code: 204 } };
  const mail = { from: "shop@example.com", to: "user@example.com", subject: "Hi", text: "Hi" };
  await assert.rejects(transporter.sendMail(mail), (error) => {
    assert.strictEqual(error.name, "ApiError");
    assert.strictEqual(error.kind, "api");
    assert.strictEqual(error.errorCode, 204);
    assert.strictEqual(error.httpStatus, 400);
    assert.strictEqual(error.method, "email/send");
    assert.strictEqual(error.retryable, false);
    return true;
  });
}

/** The webhook endpoint at `url`: GET 200, signed POST 200 (the handlers get it), a wrong signature 401. */
async function checkWebhook(url, received) {
  assert.strictEqual((await fetch(url)).status, 200);
  assert.strictEqual((await post(url, WEBHOOK)).status, 200);
  assert.deepStrictEqual(received.map((item) => item.kind), ["notification", "event", "event"]);
  assert.strictEqual(received[1].event.eventName, "transactional_email_status");
  assert.strictEqual(received[1].event.eventData?.email, "user@example.com");
  assert.strictEqual((await post(url, WEBHOOK.replace("user@", "evil@"))).status, 401);
  assert.strictEqual((await post(url, "{}")).status, 401);
  assert.strictEqual(received.length, 3);
}

/** A Nest app of the module (and the providers) on 127.0.0.1; returns the app, its URL and close(). */
async function start(module, providers = []) {
  class AppModule {}
  Module({ imports: [module], providers })(AppModule);
  const app = await NestFactory.create(AppModule, {
    rawBody: true, logger: false, abortOnError: false, forceCloseConnections: true,
  });
  await app.listen(0, "127.0.0.1");
  return { app, url: `http://127.0.0.1:${app.getHttpServer().address().port}`, close: () => app.close() };
}

function transporter(app) {
  return nodemailer.createTransport(app.get(UniOneTransport));
}

test("forRoot: the client by its class and by the token", async () => {
  const { app, close } = await start(UniOneModule.forRoot({ apiKey: API_KEY, host: api.url }));
  try {
    const client = app.get(UniOneClient);
    assert.strictEqual(app.get(UNIONE_CLIENT), client);
    await client.system.ping();
    assert.strictEqual(api.calls[0].path, "/system/ping.json");
    assert.strictEqual(api.calls[0].key, API_KEY);
    assertPlatform(api.calls[0]);
  } finally {
    await close();
  }
});

test("forRoot: API key and host from the environment", async () => {
  process.env.UNIONE_API_KEY = API_KEY;
  process.env.UNIONE_HOST = api.url;
  const { app, close } = await start(UniOneModule.forRoot());
  try {
    await app.get(UniOneClient).system.ping();
    assert.strictEqual(api.calls[0].key, API_KEY);
  } finally {
    await close();
  }
});

test("forRootAsync: options of the factory", async () => {
  const useFactory = async () => ({ apiKey: API_KEY, host: api.url });
  const { app, close } = await start(UniOneModule.forRootAsync({ useFactory }));
  try {
    await app.get(UNIONE_CLIENT).system.ping();
    assert.strictEqual(api.calls.length, 1);
  } finally {
    await close();
  }
});

test("without an API key the app does not start", async () => {
  await assert.rejects(start(UniOneModule.forRoot({ webhook: false })), /API key is not set/);
});

test("an injected client in a service", async () => {
  class UsageService {
    constructor(client) {
      this.client = client;
    }
  }
  Injectable()(UsageService);
  Inject(UniOneClient)(UsageService, undefined, 0);
  const { app, close } = await start(UniOneModule.forRoot({ apiKey: API_KEY, host: api.url }), [UsageService]);
  try {
    assert.strictEqual(app.get(UsageService).client, app.get(UniOneClient));
  } finally {
    await close();
  }
});

test("Nodemailer transport: one email/send with the mail", async () => {
  const { app, close } = await start(UniOneModule.forRoot({ apiKey: API_KEY, host: api.url }));
  try {
    await checkMail(transporter(app), api);
  } finally {
    await close();
  }
});

test("Nodemailer transport: an API error fails the send", async () => {
  const { app, close } = await start(UniOneModule.forRoot({ apiKey: API_KEY, host: api.url }));
  try {
    await checkMailError(transporter(app), api);
  } finally {
    await close();
  }
});

test("webhook: GET, signed POST to the handlers, wrong signature", async () => {
  const received = [];
  const { app, url, close } = await start(UniOneModule.forRoot({
    apiKey: API_KEY,
    host: api.url,
    onNotification: (callback) => { received.push({ kind: "notification", callback }); },
  }));
  app.get(UniOneWebhooks).onEvent((event, user) => { received.push({ kind: "event", event, user }); });
  try {
    await checkWebhook(url + "/unione/webhook", received);
  } finally {
    await close();
  }
});

test("webhook: own path, disabled", async () => {
  const own = await start(UniOneModule.forRoot({ apiKey: API_KEY, host: api.url, webhookPath: "/hooks/mail" }));
  try {
    assert.strictEqual((await post(own.url + "/hooks/mail", WEBHOOK)).status, 200);
    assert.strictEqual((await post(own.url + "/unione/webhook", WEBHOOK)).status, 404);
  } finally {
    await own.close();
  }
  const off = await start(UniOneModule.forRoot({ apiKey: API_KEY, host: api.url, webhook: false }));
  try {
    assert.strictEqual((await fetch(off.url + "/unione/webhook")).status, 404);
    assert.strictEqual((await post(off.url + "/unione/webhook", WEBHOOK)).status, 404);
  } finally {
    await off.close();
  }
});

test("webhook without a key: a warning, every POST 401", async () => {
  const client = new UniOneClient(API_KEY, { host: api.url });
  let started;
  const warned = await warnings(async () => {
    started = await start(UniOneModule.forRoot({ client }));
  });
  try {
    assert.strictEqual(started.app.get(UniOneClient), client);
    assert.ok(warned.some((text) => text.includes("webhook key is not set")), warned.join("\n"));
    assert.strictEqual((await post(started.url + "/unione/webhook", WEBHOOK)).status, 401);
  } finally {
    await started.close();
  }
});
