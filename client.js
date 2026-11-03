// DSH loads this factory in its existing browser runtime; React stays host-owned.
window.__ModuleLoader__.load({
  id: '@software-factory/plato',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'plato.settings';
    const dictionaries = {
      zh: {
        title: '运行环境配置', intro: '填写 DSH 服务端的程序路径。虚拟环境可以放在插件安装目录以外。',
        python: 'Python 解释器', pythonHint: '推荐填写虚拟环境中的 python.exe；Linux/macOS 使用 bin/python。',
        java: 'Java 程序', javaHint: '可填写 java，或服务端 Java 可执行文件的绝对路径。',
        jar: 'PlantUML JAR', jarHint: '必填，填写服务端 .jar 文件的绝对路径。',
        advanced: '高级选项', timeout: '启动等待时间（秒）', timeoutHint: '等待 Python 确认启动的时间，1～120 秒，默认 30 秒。',
        save: '保存', saving: '正在保存…', discard: '放弃修改', saved: '已保存，后续启动的任务将使用新配置。',
        dirty: '有未保存的修改', failed: '保存失败，请检查连接或服务端提示后重试。',
        conflict: '配置已在其他页面修改。请先放弃修改，读取最新配置后重新填写。',
        loading: '正在读取配置…', unavailable: '请先启用 PLATO 组合包及 sf-plato 组件；如已启用，请检查 DSH 原生设置服务并刷新页面。',
        readOnly: '当前连接无法持久保存配置。请使用有配置写入权限的 DSH 本机网页。',
        required: '请填写此项。', absolute: '请填写绝对路径，例如 D:\\Tools\\PlantUML\\plantuml.jar。',
        invalidTimeout: '请输入 1～120 之间的整数秒数。',
        usage: '保存后无需重启。正在运行的任务继续使用启动时的配置。首次运行前请确认 Python 依赖、Java、JAR 及 Runtime ≥0.2.0 均已准备好。',
      },
      en: {
        title: 'Runtime configuration', intro: 'Enter paths on the DSH server. The Python environment can live outside the plugin directory.',
        python: 'Python interpreter', pythonHint: 'Use the virtual environment’s python.exe, or bin/python on Linux/macOS.',
        java: 'Java executable', javaHint: 'Enter java or the absolute path to the server’s Java executable.',
        jar: 'PlantUML JAR', jarHint: 'Required. Enter the absolute path to the server’s .jar file.',
        advanced: 'Advanced options', timeout: 'Startup wait (seconds)', timeoutHint: 'Wait for Python startup: 1–120 seconds, default 30.',
        save: 'Save', saving: 'Saving…', discard: 'Discard changes', saved: 'Saved. New tasks will use this configuration.',
        dirty: 'Unsaved changes', failed: 'Could not save. Check the connection or server message and try again.',
        conflict: 'Another page changed this configuration. Discard your changes to load the latest values before editing again.',
        loading: 'Loading configuration…', unavailable: 'Enable the PLATO bundle and sf-plato component. If enabled, check the DSH settings service and refresh.',
        readOnly: 'This connection cannot persist configuration. Open the local DSH page with configuration write access.',
        required: 'This field is required.', absolute: 'Enter an absolute path, for example D:\\Tools\\PlantUML\\plantuml.jar.',
        invalidTimeout: 'Enter a whole number of seconds from 1 to 120.',
        usage: 'No restart is needed after saving. Running tasks keep their original configuration. Prepare Python dependencies, Java, the JAR and Runtime ≥0.2.0 before running a task.',
      },
    };
    const css = `
      .sf-plato-settings{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}
      .sf-plato-settings h4{margin:0;font-size:16px;font-weight:500}
      .sf-plato-settings p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px}
      .sf-plato-settings label{display:block;margin-bottom:6px;font-weight:500}
      .sf-plato-settings input{box-sizing:border-box;width:100%;padding:9px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit}
      .sf-plato-settings input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
      .sf-plato-settings input:focus-visible,.sf-plato-settings button:focus-visible,.sf-plato-settings summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .sf-plato-settings .sf-plato-error{color:var(--dsw-alias-label-error)}
      .sf-plato-settings details{border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}
      .sf-plato-settings summary{cursor:pointer;margin-bottom:12px}
      .sf-plato-settings footer{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
      .sf-plato-settings button{padding:7px 16px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
      .sf-plato-settings button[type=submit]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
      .sf-plato-settings button:disabled{opacity:.4;cursor:default}
    `;
    const format = value => ({
      pythonPath: value.pythonPath, javaPath: value.javaPath, plantumlJarPath: value.plantumlJarPath,
      timeoutSeconds: String(value.startupTimeoutMs / 1000),
    });
    const isAbsolute = value => /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(value);

    function Configuration({ scope, t }) {
      const observe = React.useMemo(() => ({
        subscribe: listener => scope.subscribe(listener), get: () => scope.getSnapshot(),
      }), [scope]);
      const snapshot = React.useSyncExternalStore(observe.subscribe, observe.get, observe.get);
      const [draft, setDraft] = React.useState(null);
      const [baseline, setBaseline] = React.useState(null);
      const [revision, setRevision] = React.useState(undefined);
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [errors, setErrors] = React.useState({});
      const prefix = React.useId();
      const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
      React.useEffect(() => {
        if (snapshot.status === 'ready' && snapshot.value && !dirty && !saving) {
          const next = format(snapshot.value);
          setDraft(next); setBaseline(next); setRevision(snapshot.revision);
        }
      }, [snapshot.value, snapshot.revision, snapshot.status, dirty, saving]);
      const disabled = saving || !snapshot.writable || snapshot.status !== 'ready';
      const conflict = dirty && revision !== snapshot.revision;
      function discard() {
        const current = scope.getSnapshot();
        if (!current.value) return;
        const next = format(current.value);
        setDraft(next); setBaseline(next); setRevision(current.revision);
        setErrors({}); setNotice('');
      }
      async function save(event) {
        event.preventDefault();
        if (disabled || !draft || !dirty) return;
        const invalid = {};
        for (const key of ['pythonPath', 'javaPath', 'plantumlJarPath']) if (!draft[key].trim()) invalid[key] = 'required';
        if (draft.plantumlJarPath.trim() && !isAbsolute(draft.plantumlJarPath.trim())) invalid.plantumlJarPath = 'absolute';
        const seconds = Number(draft.timeoutSeconds);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) invalid.timeoutSeconds = 'invalidTimeout';
        setErrors(invalid);
        if (Object.keys(invalid).length) return;
        setSaving(true); setNotice('');
        try {
          const values = { pythonPath: draft.pythonPath.trim(), javaPath: draft.javaPath.trim(),
            plantumlJarPath: draft.plantumlJarPath.trim(), startupTimeoutMs: seconds * 1000 };
          const accepted = await scope.mutate(Object.entries(values).map(([key, value]) => ({ op: 'set', path: [key], value })), revision);
          if (accepted) {
            const next = format(scope.getSnapshot().value ?? values);
            setDraft(next); setBaseline(next); setRevision(scope.getSnapshot().revision); setNotice('saved');
          } else setNotice(scope.getSnapshot().revision !== revision ? 'conflict' : 'failed');
        } catch (error) { setNotice(typeof error?.message === 'string' ? t('failed') + ' ' + error.message : 'failed'); }
        finally { setSaving(false); }
      }
      function field(key, title, hint, extra = {}) {
        const id = prefix + '-' + key;
        return h('div', { key },
          h('label', { htmlFor: id }, t(title)),
          h('input', { id, name: key, value: draft[key], disabled, autoComplete: 'off', spellCheck: false,
            'aria-describedby': id + '-hint' + (errors[key] ? ' ' + id + '-error' : ''),
            'aria-invalid': errors[key] ? true : undefined, ...extra,
            onChange: event => { setDraft({ ...draft, [key]: event.target.value }); setNotice(''); setErrors({ ...errors, [key]: undefined }); },
          }),
          h('p', { id: id + '-hint' }, t(hint)),
          errors[key] ? h('p', { id: id + '-error', className: 'sf-plato-error', role: 'alert' }, t(errors[key])) : null,
        );
      }
      const ready = snapshot.status === 'ready' && draft !== null;
      return h('form', { className: 'sf-plato-settings', onSubmit: save, noValidate: true },
        h('style', null, css),
        h('div', null, h('h4', null, t('title')), h('p', null, t('intro'))),
        !ready ? h('p', { role: 'status' }, t(snapshot.status === 'loading' ? 'loading' : 'unavailable')) : h(React.Fragment, null,
          !snapshot.writable ? h('p', { role: 'status' }, t('readOnly')) : null,
          field('pythonPath', 'python', 'pythonHint', { required: true, placeholder: 'D:\\DSH-Plugins\\plato-env\\Scripts\\python.exe' }),
          field('javaPath', 'java', 'javaHint', { required: true, placeholder: 'java' }),
          field('plantumlJarPath', 'jar', 'jarHint', { required: true, placeholder: 'D:\\Tools\\PlantUML\\plantuml.jar' }),
          h('details', { open: !!errors.timeoutSeconds || undefined }, h('summary', null, t('advanced')),
            field('timeoutSeconds', 'timeout', 'timeoutHint', { type: 'number', min: 1, max: 120, step: 1 })),
          h('p', null, t('usage')),
          conflict ? h('p', { className: 'sf-plato-error', role: 'status' }, t('conflict')) : null,
          h('footer', null,
            h('button', { type: 'submit', disabled: disabled || !dirty || conflict }, t(saving ? 'saving' : 'save')),
            h('button', { type: 'button', disabled: saving || !dirty, onClick: discard }, t('discard')),
            h('p', { role: 'status', className: notice && notice !== 'saved' ? 'sf-plato-error' : undefined },
              notice ? (Object.hasOwn(dictionaries.en, notice) ? t(notice) : notice) : dirty ? t('dirty') : ''),
          ),
        ),
      );
    }
    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries));
        const scope = ctx.configForms.get('sf-plato');
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: '@software-factory/plato', locale: NS,
          inject: () => ({ scope }),
        }, Configuration));
      },
    };
  },
});
