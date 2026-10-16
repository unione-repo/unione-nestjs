import type { DynamicModule } from "@nestjs/common";
import type { UniOneClient } from "unione";

export interface UniOneOptions {
  /** User or project API key, default: env UNIONE_API_KEY. */
  apiKey?: string;
  /** API host (datacenter) or a full base URL, default: env UNIONE_HOST. */
  host?: string;
  /** Request timeout in seconds, default: env UNIONE_TIMEOUT or 30. */
  timeout?: number;
  /** API key the webhooks are signed with, default: env UNIONE_WEBHOOK_KEY or apiKey. */
  webhookKey?: string;
  /** Path of the webhook endpoint, default: env UNIONE_WEBHOOK_PATH or "/unione/webhook". */
  webhookPath?: string;
}

export interface WebhookHandlers {
  /** The whole notification: parsed SDK model and decoded JSON. */
  onNotification?: (callback: any, payload: Record<string, any>, request?: any) => unknown;
  /** Each event of the notification with its user/project. */
  onEvent?: (event: any, user: any, request?: any) => unknown;
}

export interface UniOneModuleOptions extends UniOneOptions, WebhookHandlers {
  /** An existing client instead of a new one. */
  client?: UniOneClient;
  /** false: no webhook controller. */
  webhook?: boolean;
}

export interface UniOneModuleAsyncOptions {
  imports?: any[];
  inject?: any[];
  useFactory: (...args: any[]) => UniOneModuleOptions | Promise<UniOneModuleOptions>;
  /** Static: the route is registered before the factory runs. */
  webhookPath?: string;
  webhook?: boolean;
}

export declare const UNIONE_OPTIONS: string;
export declare const UNIONE_CLIENT: string;

export declare class UniOneModule {
  static forRoot(options?: UniOneModuleOptions): DynamicModule;
  static forRootAsync(options: UniOneModuleAsyncOptions): DynamicModule;
}

export declare class UniOneWebhooks {
  onNotification(handler: NonNullable<WebhookHandlers["onNotification"]>): this;
  onEvent(handler: NonNullable<WebhookHandlers["onEvent"]>): this;
}

/** Nodemailer transport: nodemailer.createTransport(transport), injectable by this class. */
export declare class UniOneTransport {
  constructor(options?: UniOneOptions & { client?: UniOneClient });
  name: string;
  version: string;
  client: UniOneClient;
  send(mail: any, callback: (err: Error | null, info?: any) => void): void;
}

export function resolveOptions(options?: UniOneOptions): Required<UniOneOptions>;
export function createClient(options?: UniOneOptions): UniOneClient;
export function verifySignature(body: string | Buffer, apiKey: string): boolean;
export function signBody(body: string, apiKey: string): string;
export function handleWebhook(body: string | Buffer, key: string, handlers?: WebhookHandlers, context?: any): Promise<{ status: number; text: string }>;
export function toMessage(data: Record<string, any>, envelope?: { from: string; to: string[] }): Record<string, any>;
