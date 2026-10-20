import type * as React from 'react';
import type { Api, ApiPayload, ApiResult } from './index.js';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  key?: React.Key;
  variant?: 'outline' | 'primary' | 'ghost';
  size?: 'sm' | 'md';
};
type ToggleProps = {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
};
export interface NativeUI {
  Button: React.ComponentType<ButtonProps>;
  Input: React.ComponentType<React.InputHTMLAttributes<HTMLInputElement>>;
  Switch: React.ComponentType<ToggleProps>;
  Checkbox: React.ComponentType<ToggleProps>;
  Tag: React.ComponentType<{ tone?: string; children?: React.ReactNode }>;
  SegmentedControl: React.ComponentType<{
    id: string;
    className?: string;
    label: string;
    value: string;
    disabled?: boolean;
    options: { value: string; label: string }[];
    onChange(value: string): void;
  }>;
  Menu: React.ComponentType<{
    open: boolean;
    portal: boolean;
    compact?: boolean;
    autoFocus: boolean;
    className: string;
    selectedId?: string;
    selectedIds?: string[];
    items: { id: string; label: string; disabled?: boolean }[];
    onSelect(id: string): void;
    onClose(): void;
    anchor: React.ReactNode;
  }>;
  IconChevronDownOutlineRegular: React.ComponentType<{ size: number }>;
}
export interface Workspace {
  path: string;
  title?: string;
}
export interface ClientContext {
  effect(setup: () => (() => unknown) | void, label?: string): void;
  locale: {
    register(id: string, values: Record<string, Record<string, string>>): () => void;
    bind(id: string): (key: string) => string;
    subscribe(callback: () => void): () => void;
    getSnapshot(): unknown;
  };
  workspaces: {
    list: {
      subscribe(callback: () => void): () => void;
      getSnapshot(): { items: Workspace[] } | undefined;
    };
  };
  connection: {
    rpc: {
      call(
        base: string,
        method: string,
        payload: unknown,
        signal?: AbortSignal,
      ): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
    };
  };
  slots: {
    inject(name: string, setup: () => unknown): () => void;
    register(meta: unknown, component: React.ComponentType): unknown;
  };
}
export interface HostRequire {
  (name: 'react'): typeof React;
  (name: '@deepseek-ai/dsh-client-ui-primitives'): NativeUI;
}
export type Call = <M extends keyof Api>(
  method: M,
  payload: ApiPayload<M>,
  signal?: AbortSignal,
) => Promise<ApiResult<M>>;
export type Run = (action: () => Promise<unknown>) => Promise<void>;
export interface FormProps {
  run: Run;
  busy: boolean;
  onClose(): void;
}

declare global {
  interface Window {
    __ModuleLoader__: {
      load(module: {
        id: string;
        factory(require: HostRequire): { inject: string[]; apply(ctx: ClientContext): void };
      }): void;
    };
    __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> };
  }
}
