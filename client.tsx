import type { ReactNode, ReactElement, ChangeEvent } from 'react';
import type {
  Workspace,
  HostRequire,
  ClientContext,
  ButtonProps,
  FormProps,
  Run,
} from './src/client-types.js';
import type { Api, ApiPayload, ApiResult } from './src/index.js';
import type {
  ScanResult,
  ImportResult,
  Server,
  DirectoryResult,
  ManagedGroup,
  ManagedGroupSummary,
  GroupMember,
} from './src/types.js';
/* Browser module shared by Harness Web and Desktop. React is supplied by Harness. */
window.__ModuleLoader__.load({
  id: 'dsh-skills-mcp-universal',
  factory(require: HostRequire) {
    const React = require('react');
    const {
      Button: HostButton,
      Input,
      Switch,
      Checkbox,
      Tag,
      SegmentedControl,
      Menu,
      IconChevronDownOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const Button = (props: ButtonProps) => h(HostButton, { type: 'button', ...props, size: 'sm' });
    const { useState, useEffect, useLayoutEffect, useRef, useCallback, useSyncExternalStore } =
      React;
    const NS = 'skills-mcp-universal';
    const zh = {
      scenarios: '分组',
      groupWorkspaces: '工作区',
      chooseWorkspace: '选择一个或多个工作区',
      noRegisteredWorkspaces: '请先在 Harness 中添加工作区',
      newGroup: '新建分组',
      editGroup: '编辑分组',
      groupName: '分组名称',
      groupMembers: '分组成员',
      groupHelp:
        'Skill 和 MCP 仅在已开启分组所选的工作区内生效。多个分组可同时开启，共享成员保持可用。',
      enableGroup: '启用分组',
      groupEnabled: '已开启',
      groupDisabled: '已停用',
      missingMembers: '有成员已不存在或只读，请编辑分组。',
      noMembers: '请先导入 Skill 或 MCP，再选择分组成员',
      groupRequired: '导入条目后，创建分组、选择工作区并开启分组才能使用。',
      notGrouped: '未加入分组',
      title: '技能与 MCP',
      skills: 'Skills',
      mcp: 'MCP 服务器',
      whenToUse: '适用场景',
      refresh: '刷新',
      search: '搜索名称或描述',
      empty: '暂无项目',
      import: '导入',
      importSkills: '导入技能',
      choose: '选择目录',
      scan: '扫描',
      path: '目录路径',
      selectAll: '全选',
      enable: '已开启',
      view: '查看',
      collapse: '收起',
      skillContent: '技能正文',
      remove: '删除',
      confirm: '确认删除',
      cancel: '取消',
      close: '关闭',
      readonly: '只读',
      skillRemoved: '已移入回收目录：',
      noSkills: '目录中没有有效技能',
      up: '上一级',
      useFolder: '使用此目录',
      browse: '浏览服务器目录',
      edit: '编辑',
      restart: '重连',
      test: '测试连接',
      save: '保存',
      jsonImport: '导入 JSON',
      jsonConfig: 'MCP JSON 配置',
      disabled: '已停用',
      starting: '正在加载',
      idle: '已开启，等待会话',
      active: '工具已加载',
      failed: '加载失败',
      tools: '工具',
      connected: '连接测试成功，发现工具数：',
      saved: '已保存',
      selectNote: '选择包含 SKILL.md 的文件夹，或包含多个技能的上级目录。',
      testFailed: '连接测试失败：',
      importResult: '导入结果',
      memberCount: '个成员',
    };
    const en = {
      scenarios: 'Groups',
      groupWorkspaces: 'Workspaces',
      chooseWorkspace: 'Select one or more workspaces',
      noRegisteredWorkspaces: 'Add a workspace in Harness first',
      newGroup: 'New group',
      editGroup: 'Edit group',
      groupName: 'Group name',
      groupMembers: 'Group members',
      groupHelp:
        'Skills and MCP are available only in the workspaces of enabled groups. Multiple groups can be enabled; shared members stay available.',
      enableGroup: 'Enable group',
      groupEnabled: 'Enabled',
      groupDisabled: 'Disabled',
      missingMembers: 'Some members are missing or read-only. Edit the group.',
      noMembers: 'Import Skills or MCP servers before selecting members',
      groupRequired:
        'Import entries, create a group, select workspaces, and enable the group to use them.',
      notGrouped: 'No group',
      title: 'Skills & MCP',
      skills: 'Skills',
      mcp: 'MCP servers',
      whenToUse: 'When to use',
      refresh: 'Refresh',
      search: 'Search names or descriptions',
      empty: 'Nothing here yet',
      import: 'Import',
      importSkills: 'Import skills',
      choose: 'Choose folder',
      scan: 'Scan',
      path: 'Directory path',
      selectAll: 'Select all',
      enable: 'Enabled',
      view: 'View',
      collapse: 'Collapse',
      skillContent: 'Skill content',
      remove: 'Delete',
      confirm: 'Confirm deletion',
      cancel: 'Cancel',
      close: 'Close',
      readonly: 'Read-only',
      skillRemoved: 'Moved to recovery directory: ',
      noSkills: 'No valid skills found',
      up: 'Parent folder',
      useFolder: 'Use this folder',
      browse: 'Browse host folders',
      edit: 'Edit',
      restart: 'Reconnect',
      test: 'Test connection',
      save: 'Save',
      jsonImport: 'Import JSON',
      jsonConfig: 'MCP JSON configuration',
      disabled: 'Disabled',
      starting: 'Loading',
      idle: 'Enabled, waiting for a session',
      active: 'Tools loaded',
      failed: 'Failed',
      tools: 'Tools',
      connected: 'Connection test passed. Discovered tools: ',
      saved: 'Saved',
      selectNote:
        'Choose a folder containing SKILL.md, or a parent directory containing several skills.',
      testFailed: 'Connection test failed: ',
      importResult: 'Import results',
      memberCount: 'members',
    };
    const css = `
      .smu{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:8px;min-width:0;width:100%;max-width:760px}
      .smu h2,.smu h3,.smu p{margin:0}.smu h2{font-size:16px;line-height:24px;font-weight:600}.smu h3{font:var(--dsw-font-xs-13);font-weight:600}
      .smu .muted{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
      .smu .row{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.smu .spread{justify-content:space-between}
      .smu .grow{flex:1;min-width:100px}.smu .stack{display:flex;flex-direction:column;gap:8px}
      /* Align all controls with the host Button's compact sm size, including borders. */
      .smu .control-input{box-sizing:border-box;height:28px;border-radius:var(--dsw-radius-sm)}.smu .control-input input{font-size:12px;line-height:18px}.smu .field-actions{align-items:flex-end}
      .smu .danger{color:var(--dsw-alias-state-error-primary)}
      .smu .field{display:flex;flex-direction:column;gap:4px;min-width:0}.smu .field>span:first-child{font:var(--dsw-font-xxs-12);font-weight:500}
      .smu .choice{display:flex;min-width:0}.smu .choice>button{width:100%;justify-content:space-between}.smu .choice-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* Compact ConfigField geometry retains the host palette, focus and radius tokens. */
      .smu textarea{box-sizing:border-box;width:100%;min-width:0;min-height:28px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);resize:vertical}
      .smu textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
      .smu .card{border:.5px solid var(--dsw-alias-border-l2);padding:10px;border-radius:var(--dsw-radius-md);min-width:0}
      .smu .notice{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap}
      .smu .notice.error{color:var(--dsw-alias-state-error-primary)}.smu pre{max-height:330px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:var(--dsw-font-xxs-12);margin:6px 0}
      .smu .form-stack{gap:10px}
      /* Retain the native adaptive field layout with compact spacing. */
      .smu .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px}.smu .full{grid-column:1/-1}
      .smu .folder-list{max-height:210px;overflow:auto;display:flex;flex-direction:column;gap:2px}.smu .folder-list button{justify-content:flex-start;flex-shrink:0;text-align:left}
      .smu .tabs{align-self:flex-start;padding:2px;border-radius:var(--dsw-radius-sm)}
      .smu .tabs [role="tab"]{height:24px;padding:0 12px;font-size:12px;line-height:18px}
      .smu .tabs>[aria-hidden="true"]{top:2px;left:2px;height:calc(100% - 4px);width:calc((100% - 4px - 2px * (var(--dsh-segment-count) - 1)) / var(--dsh-segment-count))}
      .smu label:has(>input[type="checkbox"]){font-size:13px;line-height:18px}.smu input[type="checkbox"]{width:14px;height:14px}
      .smu [data-tone]{padding:0 6px;line-height:17px}.smu details summary{cursor:pointer;font:var(--dsw-font-xxs-12)}.smu .empty{padding:12px 0;color:var(--dsw-alias-label-tertiary)}
      .smu .tool-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font:var(--dsw-font-xxs-12);overflow-wrap:anywhere}
      .smu .members-masonry{column-width:200px;column-gap:8px}
      .smu .member-card{display:inline-flex;flex-direction:column;gap:6px;box-sizing:border-box;width:100%;padding:10px;margin:0 0 8px;break-inside:avoid;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow-wrap:anywhere}
      .smu .member-card[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-3)}
    `;
    const jsonExample = `{
  "mcpServers": {
    "example-server": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": {}
    }
  }
}`;
    const serverJson = ({ name, enabled, ...config }: Server) =>
      JSON.stringify({ mcpServers: { [name]: config } }, null, 2);
    return {
      inject: ['slots', 'connection', 'locale', 'workspaces'],
      apply(ctx: ClientContext) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skills-mcp-universal: locale');
        const t = ctx.locale.bind(NS);
        async function call<M extends keyof Api>(
          method: M,
          payload: ApiPayload<M>,
          signal?: AbortSignal,
        ): Promise<ApiResult<M>> {
          const result = await ctx.connection.rpc.call('/api', `${NS}/${method}`, payload, signal);
          if (!result.ok) throw new Error(result.error.message);
          return result.value as ApiResult<M>;
        }
        function button(text: ReactNode, onClick: ButtonProps['onClick'], extra: ButtonProps = {}) {
          const { className = '', ...props } = extra;
          return h(
            Button,
            {
              variant: className.includes('primary') ? 'primary' : 'outline',
              size: 'sm',
              onClick,
              ...props,
              className: className.includes('danger') ? 'danger' : undefined,
            },
            text,
          );
        }
        function field(label: string, child: ReactElement, full = false) {
          return h(
            'div',
            { className: 'field' + (full ? ' full' : '') },
            h('span', null, label),
            React.cloneElement(child as ReactElement<{ 'aria-label'?: string }>, {
              'aria-label': label,
            }),
          );
        }
        function WorkspaceSelect({
          value,
          workspaces,
          onChange,
          disabled = false,
          'aria-label': label,
        }: {
          value: string[];
          workspaces: Workspace[];
          onChange(value: string[]): void;
          disabled?: boolean;
          'aria-label'?: string;
        }) {
          const [open, setOpen] = useState(false);
          const choices = [
            ...new Map(
              [...workspaces, ...value.map((path) => ({ path }))].map((workspace) => [
                workspace.path,
                workspace,
              ]),
            ).values(),
          ];
          const title = (path: string) =>
            workspaces.find((item) => item.path === path)?.title || path;
          return h(Menu, {
            open,
            portal: true,
            compact: true,
            autoFocus: true,
            className: 'choice',
            selectedIds: value,
            items: choices.map((workspace) => ({
              id: workspace.path,
              label: title(workspace.path),
              disabled,
            })),
            onSelect: (path) =>
              onChange(
                value.includes(path) ? value.filter((item) => item !== path) : [...value, path],
              ),
            onClose: () => setOpen(false),
            anchor: h(
              Button,
              {
                variant: 'outline',
                disabled: disabled || !choices.length,
                'aria-label': label ?? t('groupWorkspaces'),
                'aria-haspopup': 'menu',
                'aria-expanded': open,
                onClick: () => setOpen(!open),
              },
              h(
                'span',
                { className: 'choice-label' },
                value.length ? value.map(title).join(', ') : t('chooseWorkspace'),
              ),
              h(IconChevronDownOutlineRegular, { size: 16 }),
            ),
          });
        }
        function useLocale() {
          useSyncExternalStore(
            (callback) => ctx.locale.subscribe(callback),
            () => ctx.locale.getSnapshot(),
          );
        }
        const emptyWorkspaces = { items: [] };
        function useWorkspaces() {
          return useSyncExternalStore(
            (callback) => ctx.workspaces.list.subscribe(callback),
            () => ctx.workspaces.list.getSnapshot() ?? emptyWorkspaces,
          ).items;
        }
        function toggle(
          label: string,
          enabled: boolean,
          onChange: (enabled: boolean) => void,
          disabled = false,
        ) {
          return h(
            'span',
            { className: 'row' },
            h('span', { className: 'muted' }, enabled ? t('enable') : t('disabled')),
            h(Switch, { label, checked: enabled, onChange, disabled }),
          );
        }
        function DirectoryBrowser({
          onChoose,
          onClose,
        }: {
          onChoose(path: string): void;
          onClose(): void;
        }) {
          const [directory, setDirectory] = useState<DirectoryResult | null>(null);
          const [error, setError] = useState('');
          const [busy, setBusy] = useState(false);
          const load = async (path?: string) => {
            setBusy(true);
            try {
              setDirectory(await call('directory', { path }));
              setError('');
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          };
          useEffect(() => {
            void load();
          }, []);
          return h(
            'div',
            { className: 'card stack form-stack', role: 'group', 'aria-label': t('browse') },
            h(
              'div',
              { className: 'row spread' },
              h('strong', null, t('browse')),
              button(t('close'), onClose),
            ),
            directory && h('div', { className: 'muted' }, directory.path),
            error && h('div', { className: 'notice error', role: 'alert' }, error),
            directory &&
              h(
                'div',
                { className: 'folder-list' },
                button('↑ ' + t('up'), () => load(directory.parent), {
                  className: 'small',
                  variant: 'ghost',
                  disabled: busy || directory.parent === directory.path,
                }),
                ...directory.entries.map((entry) =>
                  button(
                    h('span', { className: 'choice-label' }, '▸ ' + entry.name),
                    () => load(entry.path),
                    {
                      key: entry.path,
                      className: 'small',
                      variant: 'ghost',
                      disabled: busy,
                      title: entry.path,
                    },
                  ),
                ),
              ),
            directory &&
              button(t('useFolder'), () => onChoose(directory.path), {
                className: 'primary',
                disabled: busy,
              }),
          );
        }
        function SkillImport({
          onDone,
          onClose,
          run,
          busy,
        }: FormProps & { onDone(results: ImportResult[]): Promise<void> }) {
          const [directory, setDirectory] = useState('');
          const [scan, setScan] = useState<ScanResult | null>(null);
          const [selection, setSelection] = useState<string[]>([]);
          const [browse, setBrowse] = useState(false);
          const choose = () =>
            run(async () => {
              const desktop = window.__DSH_DIRECTORY_PICKER__;
              if (desktop?.pick) {
                try {
                  const path = await desktop.pick();
                  if (path) {
                    setDirectory(path);
                    setScan(null);
                  }
                  return;
                } catch {
                  /* Native chooser unavailable: use the authenticated host browser. */
                }
              }
              setBrowse(true);
            });
          const scanDirectory = () =>
            run(async () => {
              const result = await call('skillScan', { directory });
              setScan(result);
              setSelection(result.items.map((item) => item.sourcePath));
            });
          return h(
            'section',
            { className: 'card stack form-stack', 'aria-label': t('importSkills') },
            h(
              'div',
              { className: 'row spread' },
              h('strong', null, t('importSkills')),
              button(t('close'), onClose),
            ),
            h('p', { className: 'muted' }, t('selectNote')),
            h(
              'div',
              { className: 'row' },
              h(Input, {
                className: 'grow control-input',
                'aria-label': t('path'),
                value: directory,
                placeholder: t('path'),
                onChange: (e) => {
                  setDirectory(e.target.value);
                  setScan(null);
                },
              }),
              button(t('choose'), choose, { disabled: busy }),
              button(t('scan'), scanDirectory, { disabled: busy || !directory }),
            ),
            browse &&
              h(DirectoryBrowser, {
                onChoose: (path) => {
                  setDirectory(path);
                  setScan(null);
                  setBrowse(false);
                },
                onClose: () => setBrowse(false),
              }),
            scan &&
              h(
                'div',
                { className: 'stack' },
                scan.items.length
                  ? h(
                      React.Fragment,
                      null,
                      h(Checkbox, {
                        label: t('selectAll'),
                        checked: selection.length === scan.items.length,
                        onChange: (checked) =>
                          setSelection(checked ? scan.items.map((item) => item.sourcePath) : []),
                      }),
                      ...scan.items.map((item) =>
                        h(Checkbox, {
                          key: item.sourcePath,
                          label: item.name,
                          checked: selection.includes(item.sourcePath),
                          onChange: (checked) =>
                            setSelection(
                              checked
                                ? [...selection, item.sourcePath]
                                : selection.filter((path) => path !== item.sourcePath),
                            ),
                        }),
                      ),
                      h(
                        'div',
                        { className: 'row' },
                        button(
                          `${t('import')} (${selection.length})`,
                          () =>
                            run(async () => {
                              const results = await call('skillImport', {
                                token: scan.token,
                                paths: selection,
                              });
                              await onDone(results);
                              if (results.every((item) => item.ok)) onClose();
                            }),
                          { disabled: busy || !selection.length, className: 'primary' },
                        ),
                      ),
                    )
                  : h('p', { className: 'muted' }, t('noSkills')),
              ),
          );
        }
        function ServerEditor({
          initial,
          originCwd,
          onClose,
          onSaved,
          run,
          busy,
          notice,
        }: FormProps & {
          initial: Server;
          originCwd?: string;
          onSaved(): Promise<void>;
          notice(text: string): void;
        }) {
          const [json, setJson] = useState(() => serverJson(initial));
          return h(
            'form',
            {
              className: 'card stack form-stack',
              'aria-label': t('edit') + ' MCP',
              onSubmit: (e) => {
                e.preventDefault();
                e.stopPropagation();
                run(async () => {
                  await call('serverSaveJson', {
                    json,
                    previousName: initial.name,
                    originCwd,
                  });
                  onClose();
                  await onSaved();
                });
              },
            },
            h(
              'div',
              { className: 'row spread' },
              h('span', { className: 'row' }, h('strong', null, t('edit') + ' MCP')),
              button(t('cancel'), onClose, { disabled: busy }),
            ),
            field(
              t('jsonConfig'),
              h('textarea', {
                value: json,
                rows: 10,
                placeholder: jsonExample,
                onChange: (e: ChangeEvent<HTMLTextAreaElement>) => setJson(e.target.value),
                autoComplete: 'off',
                spellCheck: false,
              }),
            ),
            h(
              'div',
              { className: 'row' },
              button(
                t('test'),
                () =>
                  run(async () => {
                    const result = await call('serverTestJson', { json });
                    if (!result.ok) throw new Error(t('testFailed') + result.error);
                    notice(t('connected') + result.tools.length);
                  }),
                { disabled: busy || !json.trim() },
              ),
              h(
                Button,
                { type: 'submit', variant: 'primary', disabled: busy || !json.trim() },
                t('save'),
              ),
            ),
          );
        }
        const memberId = (member: GroupMember) =>
          member.kind === 'skill'
            ? 'skill:' + member.path
            : 'mcp:' + (member.cwd ?? '') + ':' + member.name;
        type MemberOption = {
          member: GroupMember;
          label: string;
          description?: string;
          path?: string;
        };

        function GroupEditor({
          initial,
          options,
          workspaces,
          onSaved,
          onClose,
          run,
          busy,
        }: FormProps & {
          initial: ManagedGroup | null;
          options: MemberOption[];
          workspaces: Workspace[];
          onSaved(): Promise<void>;
        }) {
          const [name, setName] = useState(initial?.name ?? '');
          const [members, setMembers] = useState<GroupMember[]>(initial?.members ?? []);
          const [selection, setSelection] = useState(initial?.workspaces ?? []);
          const available = new Set(options.map((option) => memberId(option.member)));
          const choices = [
            ...options,
            ...members
              .filter((member) => !available.has(memberId(member)))
              .map((member) => ({
                member,
                label: member.kind === 'mcp' ? member.name : member.path,
                description: t('missingMembers'),
                path: undefined,
              })),
          ];
          return h(
            'form',
            {
              className: initial ? 'stack form-stack' : 'card stack form-stack',
              'aria-label': initial ? t('editGroup') : t('newGroup'),
              onSubmit: (event) => {
                event.preventDefault();
                event.stopPropagation();
                void run(async () => {
                  await call('groupSave', {
                    group: { id: initial?.id, name, members, workspaces: selection },
                  });
                  onClose();
                  await onSaved();
                });
              },
            },
            h(
              'div',
              { className: 'row spread' },
              h('strong', null, initial ? t('editGroup') : t('newGroup')),
              button(t('cancel'), onClose, { disabled: busy }),
            ),
            field(
              t('groupName'),
              h(Input, {
                className: 'control-input',
                value: name,
                maxLength: 64,
                disabled: busy,
                onChange: (event) => setName(event.target.value),
              }),
            ),
            field(
              t('groupWorkspaces'),
              h(WorkspaceSelect, {
                value: selection,
                workspaces,
                disabled: busy,
                onChange: setSelection,
              }),
            ),
            !workspaces.length && h('p', { className: 'muted' }, t('noRegisteredWorkspaces')),
            h(
              'div',
              { className: 'row spread' },
              h('strong', null, t('groupMembers')),
              h(Checkbox, {
                label: t('selectAll'),
                disabled: busy || !options.length,
                checked:
                  options.length > 0 &&
                  members.length === options.length &&
                  options.every((option) =>
                    members.some((member) => memberId(member) === memberId(option.member)),
                  ),
                onChange: (checked) =>
                  setMembers(checked ? options.map((option) => option.member) : []),
              }),
            ),
            h(
              'div',
              { className: 'members-masonry', role: 'group', 'aria-label': t('groupMembers') },
              ...choices.map((option) => {
                const checked = members.some(
                  (member) => memberId(member) === memberId(option.member),
                );
                return h(
                  'div',
                  {
                    className: 'member-card',
                    key: memberId(option.member),
                    'data-selected': checked,
                  },
                  h(Checkbox, {
                    label: option.label,
                    checked,
                    disabled: busy,
                    onChange: (selected) =>
                      setMembers((current) =>
                        selected
                          ? [...current, option.member]
                          : current.filter(
                              (member) => memberId(member) !== memberId(option.member),
                            ),
                      ),
                  }),
                  option.description && h('p', { className: 'muted' }, option.description),
                  option.path && h('p', { className: 'muted' }, option.path),
                );
              }),
            ),
            !choices.length && h('p', { className: 'muted' }, t('noMembers')),
            h(
              'div',
              { className: 'row' },
              h(
                Button,
                {
                  type: 'submit',
                  variant: 'primary',
                  disabled: busy || !name.trim() || !members.length || !selection.length,
                },
                t('save'),
              ),
            ),
          );
        }

        function Manager() {
          useLocale();
          const registeredWorkspaces = useWorkspaces();
          const [workspaceRoots, setWorkspaceRoots] = useState<Record<string, string>>({});
          const workspaces = registeredWorkspaces.map((item) => ({
            ...item,
            path: workspaceRoots[item.path] ?? item.path,
          }));
          const workspaceKey = registeredWorkspaces.map((item) => item.path).join('\n');
          const [tab, setTab] = useState('groups');
          const [search, setSearch] = useState('');
          const [items, setItems] = useState<ApiResult<'skills'>>([]);
          const [servers, setServers] = useState<ApiResult<'servers'>>([]);
          const [groups, setGroups] = useState<ManagedGroupSummary[]>([]);
          const [busy, setBusy] = useState(false);
          const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
          const [skillImport, setSkillImport] = useState(false);
          const [editor, setEditor] = useState<{ server: Server; originCwd?: string } | null>(null);
          const [jsonOpen, setJsonOpen] = useState(false);
          const [json, setJson] = useState('');
          const [detail, setDetail] = useState<ApiResult<'skillRead'> | null>(null);
          const [deleting, setDeleting] = useState<string | null>(null);
          const [groupEditor, setGroupEditor] = useState<ManagedGroup | null | undefined>(
            undefined,
          );
          const returnToEditView = useRef<(() => void) | null>(null);
          const rememberEditView = (trigger: HTMLButtonElement) => {
            const positions: { element: HTMLElement; top: number; left: number }[] = [];
            for (let element = trigger.parentElement; element; element = element.parentElement)
              positions.push({ element, top: element.scrollTop, left: element.scrollLeft });
            const item = trigger.closest('[data-edit-item]');
            const top = window.scrollY,
              left = window.scrollX;
            returnToEditView.current = () => {
              const target = trigger.isConnected
                ? trigger
                : item?.querySelector<HTMLButtonElement>('[data-edit-trigger]');
              target?.focus({ preventScroll: true });
              for (const position of positions) {
                if (!position.element.isConnected) continue;
                position.element.scrollTop = position.top;
                position.element.scrollLeft = position.left;
              }
              window.scrollTo({ top, left, behavior: 'instant' });
            };
          };
          useLayoutEffect(() => {
            if (busy || groupEditor !== undefined || editor || !returnToEditView.current) return;
            const restore = returnToEditView.current;
            returnToEditView.current = null;
            restore();
            const frame = requestAnimationFrame(restore);
            return () => cancelAnimationFrame(frame);
          }, [groupEditor, editor, busy]);
          const load = useCallback(
            async (signal?: AbortSignal) => {
              const nextGroups = await call(
                'groups',
                { workspaces: workspaceKey ? workspaceKey.split('\n') : [] },
                signal,
              );
              const [skills, mcp] = await Promise.all([
                call('skills', {}, signal),
                call('servers', {}, signal),
              ]);
              if (signal?.aborted) return;
              setGroups(nextGroups.items);
              setWorkspaceRoots(nextGroups.workspaceRoots);
              setItems(skills);
              setServers(mcp);
            },
            [workspaceKey],
          );
          const run: Run = async (action) => {
            if (busy) return;
            setBusy(true);
            setNotice(null);
            try {
              await action();
            } catch (error) {
              setNotice({ error: true, text: error.message });
            } finally {
              setBusy(false);
            }
          };
          useEffect(() => {
            const controller = new AbortController();
            const refresh = () => {
              if (document.visibilityState !== 'hidden')
                void load(controller.signal).catch((error) => {
                  if (!controller.signal.aborted) setNotice({ error: true, text: error.message });
                });
            };
            refresh();
            const timer = setInterval(refresh, 3000);
            return () => {
              clearInterval(timer);
              controller.abort();
            };
          }, [load]);
          const options: MemberOption[] = [
            ...items
              .filter((item) => item.writable && !item.error)
              .map((item) => ({
                member: { kind: 'skill' as const, path: item.path },
                label: 'Skill · ' + item.name,
                description: item.description,
                path: item.originCwd,
              })),
            ...servers.map((server) => ({
              member: { kind: 'mcp' as const, name: server.name, cwd: server.originCwd },
              label: 'MCP · ' + server.name,
              description: server.transport + ' · ' + server.target,
              path: server.originCwd,
            })),
          ];
          const membership = (member: GroupMember) => {
            const matches = groups.filter((group) =>
              group.members.some((item) => memberId(item) === memberId(member)),
            );
            return h(
              'span',
              { className: 'row' },
              ...(matches.length
                ? matches.map((group) =>
                    h(
                      Tag,
                      { key: group.id, tone: group.enabled ? 'success' : 'neutral' },
                      group.name,
                    ),
                  )
                : [h(Tag, { key: 'none', tone: 'quiet' }, t('notGrouped'))]),
            );
          };
          const confirm = (id: string, action: () => Promise<unknown>) =>
            deleting === id
              ? h(
                  'span',
                  { className: 'row' },
                  button(t('confirm'), () => run(action), { className: 'danger', disabled: busy }),
                  button(t('cancel'), () => setDeleting(null), { disabled: busy }),
                )
              : button(t('remove'), () => setDeleting(id), { className: 'danger', disabled: busy });
          const filtered = <T extends { name: string; description?: string }>(values: T[]) =>
            values.filter((item) =>
              `${item.name} ${item.description ?? ''}`.toLowerCase().includes(search.toLowerCase()),
            );
          return h(
            'div',
            { className: 'smu', 'data-testid': NS },
            h('style', null, css),
            h(
              'div',
              { className: 'row spread' },
              h('h2', null, t('title')),
              button(t('refresh'), () => run(() => load()), { disabled: busy }),
            ),
            h(SegmentedControl, {
              id: NS,
              className: 'tabs',
              label: t('title'),
              value: tab,
              disabled: busy,
              options: [
                { value: 'groups', label: t('scenarios') },
                { value: 'skills', label: t('skills') },
                { value: 'mcp', label: t('mcp') },
              ],
              onChange: (value) => {
                returnToEditView.current = null;
                setTab(value);
                setSearch('');
                setNotice(null);
                setDeleting(null);
                setGroupEditor(undefined);
                setSkillImport(false);
                setJsonOpen(false);
                setEditor(null);
                setDetail(null);
              },
            }),
            notice &&
              h(
                'p',
                {
                  role: notice.error ? 'alert' : 'status',
                  className: 'notice' + (notice.error ? ' error' : ''),
                },
                notice.text,
              ),
            tab === 'groups'
              ? h(
                  'div',
                  {
                    className: 'stack',
                    role: 'tabpanel',
                    id: NS + '-groups-panel',
                    'aria-labelledby': NS + '-groups',
                  },
                  h(
                    'div',
                    { className: 'row' },
                    button(
                      t('newGroup'),
                      (event) => {
                        rememberEditView(event.currentTarget);
                        setGroupEditor(null);
                      },
                      { disabled: busy },
                    ),
                  ),
                  h('p', { className: 'muted' }, t('groupHelp')),
                  groupEditor === null &&
                    h(GroupEditor, {
                      key: 'new',
                      initial: null,
                      options,
                      workspaces,
                      run,
                      busy,
                      onSaved: () => load(),
                      onClose: () => setGroupEditor(undefined),
                    }),
                  ...groups.map((group) =>
                    h(
                      'article',
                      {
                        key: group.id,
                        className: 'card stack form-stack',
                        'aria-label': group.name,
                        'data-edit-item': group.id,
                      },
                      groupEditor?.id === group.id
                        ? h(GroupEditor, {
                            key: group.id,
                            initial: groupEditor,
                            options,
                            workspaces,
                            run,
                            busy,
                            onSaved: () => load(),
                            onClose: () => setGroupEditor(undefined),
                          })
                        : h(
                            React.Fragment,
                            null,
                            h(
                              'div',
                              { className: 'row spread' },
                              h('strong', null, group.name),
                              toggle(
                                t('enableGroup') + ' ' + group.name,
                                group.enabled,
                                (enabled) => {
                                  void run(async () => {
                                    await call('groupApply', { id: group.id, enabled });
                                    await load();
                                  });
                                },
                                busy ||
                                  (!group.enabled &&
                                    (!group.members.length ||
                                      !group.workspaces.length ||
                                      !!group.missing)),
                              ),
                            ),
                            field(
                              t('groupWorkspaces'),
                              h(WorkspaceSelect, {
                                value: group.workspaces,
                                workspaces,
                                disabled: busy,
                                onChange: (selection) => {
                                  void run(async () => {
                                    await call('groupAssign', {
                                      id: group.id,
                                      workspaces: selection,
                                    });
                                    await load();
                                  });
                                },
                              }),
                            ),
                            h(
                              'p',
                              { className: 'muted' },
                              `${group.members.length} ${t('memberCount')}`,
                            ),
                            !!group.missing &&
                              h('p', { className: 'notice error' }, t('missingMembers')),
                            h(
                              'div',
                              { className: 'row' },
                              button(
                                t('edit'),
                                (event) => {
                                  rememberEditView(event.currentTarget);
                                  setGroupEditor(group);
                                },
                                { disabled: busy, 'data-edit-trigger': true } as ButtonProps,
                              ),
                              confirm('group:' + group.id, async () => {
                                await call('groupRemove', { id: group.id });
                                if (groupEditor?.id === group.id) setGroupEditor(undefined);
                                setDeleting(null);
                                await load();
                              }),
                            ),
                          ),
                    ),
                  ),
                  !groups.length &&
                    groupEditor === undefined &&
                    h('p', { className: 'empty' }, t('empty')),
                )
              : h(
                  'div',
                  {
                    className: 'stack',
                    role: 'tabpanel',
                    id: NS + '-' + tab + '-panel',
                    'aria-labelledby': NS + '-' + tab,
                  },
                  h('p', { className: 'muted' }, t('groupRequired')),
                  h(
                    'div',
                    { className: 'row' },
                    h(Input, {
                      className: 'grow control-input',
                      value: search,
                      placeholder: t('search'),
                      'aria-label': t('search'),
                      onChange: (event) => setSearch(event.target.value),
                    }),
                    button(
                      tab === 'skills' ? t('importSkills') : t('jsonImport'),
                      () => {
                        returnToEditView.current = null;
                        if (tab === 'skills') setSkillImport(!skillImport);
                        else {
                          setJsonOpen(!jsonOpen);
                          setEditor(null);
                        }
                      },
                      { disabled: busy },
                    ),
                  ),
                  tab === 'skills'
                    ? h(
                        React.Fragment,
                        null,
                        skillImport &&
                          h(SkillImport, {
                            run,
                            busy,
                            onClose: () => setSkillImport(false),
                            onDone: async (results) => {
                              await load();
                              setNotice({
                                text: results
                                  .map(
                                    (item) =>
                                      item.name + ': ' + (item.ok ? t('saved') : item.error),
                                  )
                                  .join('\n'),
                                error: results.some((item) => !item.ok),
                              });
                            },
                          }),
                        ...filtered(items).map((item) =>
                          h(
                            'article',
                            { key: item.path, className: 'card stack' },
                            h(
                              'div',
                              { className: 'row spread' },
                              h('strong', null, item.name),
                              membership({ kind: 'skill', path: item.path }),
                            ),
                            h(
                              'p',
                              { className: item.error ? 'notice error' : 'muted' },
                              item.error || item.description,
                            ),
                            h('p', { className: 'muted' }, item.path),
                            h(
                              'div',
                              { className: 'row' },
                              button(
                                detail?.path === item.path ? t('collapse') : t('view'),
                                () =>
                                  detail?.path === item.path
                                    ? setDetail(null)
                                    : run(async () =>
                                        setDetail(await call('skillRead', { path: item.path })),
                                      ),
                                {
                                  disabled: busy || !!item.error,
                                  'aria-expanded': detail?.path === item.path,
                                },
                              ),
                              item.writable
                                ? confirm(item.path, async () => {
                                    const result = await call('skillRemove', { path: item.path });
                                    setDeleting(null);
                                    setDetail(null);
                                    await load();
                                    setNotice({ text: t('skillRemoved') + result.recoveryPath });
                                  })
                                : h(Tag, { tone: 'quiet' }, t('readonly')),
                            ),
                            detail?.path === item.path &&
                              h(
                                'div',
                                {
                                  role: 'region',
                                  'aria-label': item.name + ' ' + t('skillContent'),
                                },
                                detail.whenToUse &&
                                  h(
                                    'p',
                                    { className: 'muted' },
                                    t('whenToUse') + ': ' + detail.whenToUse,
                                  ),
                                h('pre', null, detail.content),
                              ),
                          ),
                        ),
                        !filtered(items).length && h('p', { className: 'empty' }, t('empty')),
                      )
                    : h(
                        React.Fragment,
                        null,
                        jsonOpen &&
                          h(
                            'section',
                            { className: 'card stack form-stack', 'aria-label': t('jsonImport') },
                            h('strong', null, t('jsonImport')),
                            h('textarea', {
                              value: json,
                              onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
                                setJson(event.target.value),
                              placeholder: jsonExample,
                              'aria-label': t('jsonConfig'),
                              rows: 10,
                              autoComplete: 'off',
                              spellCheck: false,
                            }),
                            h(
                              'div',
                              { className: 'row' },
                              button(
                                t('import'),
                                () =>
                                  run(async () => {
                                    await call('serverImport', { json });
                                    setJsonOpen(false);
                                    setJson('');
                                    await load();
                                  }),
                                { className: 'primary', disabled: busy || !json.trim() },
                              ),
                              button(t('cancel'), () => setJsonOpen(false), { disabled: busy }),
                            ),
                          ),
                        editor &&
                          h(ServerEditor, {
                            key: (editor.originCwd ?? '') + ':' + editor.server.name,
                            initial: editor.server,
                            originCwd: editor.originCwd,
                            run,
                            busy,
                            onClose: () => setEditor(null),
                            onSaved: () => load(),
                            notice: (text) => setNotice({ text }),
                          }),
                        ...filtered(servers).map((server) =>
                          h(
                            'article',
                            {
                              key: (server.originCwd ?? '') + ':' + server.name,
                              className: 'card stack',
                              'data-edit-item': (server.originCwd ?? '') + ':' + server.name,
                            },
                            h(
                              'div',
                              { className: 'row spread' },
                              h('strong', null, server.name),
                              membership({ kind: 'mcp', name: server.name, cwd: server.originCwd }),
                            ),
                            h(
                              'div',
                              null,
                              h(
                                Tag,
                                {
                                  tone:
                                    server.state === 'active'
                                      ? 'success'
                                      : server.state === 'failed'
                                        ? 'danger'
                                        : 'quiet',
                                },
                                t(server.state),
                              ),
                            ),
                            h(
                              'p',
                              { className: 'muted' },
                              server.transport + ' · ' + server.target,
                            ),
                            server.originCwd && h('p', { className: 'muted' }, server.originCwd),
                            server.error && h('p', { className: 'notice error' }, server.error),
                            h(
                              'div',
                              { className: 'row' },
                              button(
                                t('edit'),
                                (event) => {
                                  rememberEditView(event.currentTarget);
                                  void run(async () => {
                                    setJsonOpen(false);
                                    setEditor({
                                      server: await call('serverRead', {
                                        name: server.name,
                                        originCwd: server.originCwd,
                                      }),
                                      originCwd: server.originCwd,
                                    });
                                  });
                                },
                                { disabled: busy, 'data-edit-trigger': true } as ButtonProps,
                              ),
                              server.state === 'active' &&
                                button(
                                  t('restart'),
                                  () =>
                                    run(async () => {
                                      await call('serverRestart', {
                                        name: server.name,
                                        originCwd: server.originCwd,
                                      });
                                      await load();
                                    }),
                                  { disabled: busy },
                                ),
                              confirm(
                                'server:' + (server.originCwd ?? '') + ':' + server.name,
                                async () => {
                                  await call('serverRemove', {
                                    name: server.name,
                                    originCwd: server.originCwd,
                                  });
                                  setDeleting(null);
                                  await load();
                                },
                              ),
                            ),
                            h(
                              'details',
                              null,
                              h('summary', null, `${t('tools')} (${server.tools.length})`),
                              h(
                                'ul',
                                {
                                  className: 'tool-list',
                                  'aria-label': server.name + ' ' + t('tools'),
                                },
                                ...server.tools.map((tool) =>
                                  h('li', { key: tool.name }, tool.name),
                                ),
                              ),
                            ),
                          ),
                        ),
                        !filtered(servers).length &&
                          !editor &&
                          h('p', { className: 'empty' }, t('empty')),
                      ),
                ),
          );
        }
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: NS,
                  order: 25,
                  label: () => t('title'),
                  locale: NS,
                },
                Manager,
              ),
            ),
          'skills-mcp-universal: settings page',
        );
      },
    };
  },
});
