const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

test('Cursor-compatible sidebar contribution registers the chat view', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar, undefined);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, 'routerChatSidebar');
  assert.equal(manifest.contributes.views.routerChatSidebar[0].id, 'routerChat.chat');
});

test('rendered chat buttons bind and send their expected messages', () => {
  const commands = new Map();
  const panels = [];
  let viewId;
  const vscode = {
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
    window: {
      registerWebviewViewProvider(id, provider) { viewId = id; const view = this.createWebviewPanel(); view.show = () => {}; provider.resolveWebviewView(view); return { dispose() {} }; },
      createWebviewPanel() {
        const panel = {
          webview: { html: '', postMessage() {}, onDidReceiveMessage() { return { dispose() {} }; } },
          onDidDispose() { return { dispose() {} }; },
          reveal() {}
        };
        panels.push(panel);
        return panel;
      }
    },
    ViewColumn: { One: 1, Beside: 2 },
    Uri: { joinPath: (...parts) => parts.join('/') }
  };
  const originalLoad = Module._load;
  Module._load = function(request, ...args) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);
  };
  try {
    const extension = require('../out/extension.js');
    extension.activate({ extensionUri: 'extension', subscriptions: [], globalState: { get() {} }, workspaceState: { get() {}, async update() {} }, secrets: { async get() {} } });
  } finally {
    Module._load = originalLoad;
  }
  commands.get('routerChat.openChat')();
  assert.equal(viewId, 'routerChat.chat');
  const script = panels[0].webview.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'chat webview script exists');
  const handlers = new Map();
  const elements = new Map();
  const windowHandlers = new Map();
  const makeNode = id => {
    const classes = new Set();
    return {
      id, value: '', textContent: '', disabled: false, hidden: id === 'contextMenu', options: [], children: [], style: {},
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name) { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; } },
      addEventListener: (event, handler) => handlers.set(`${id}:${event}`, handler),
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      replaceChildren() { this.options = []; this.children = []; },
      append(...nodes) { this.options.push(...nodes); this.children.push(...nodes); },
      insertBefore(node) { this.children.unshift(node); },
      scrollIntoView() {}, focus() {}, remove() {}
    };
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeNode(id));
    return elements.get(id);
  };
  const messages = [];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }),
    document: { getElementById: element, createElement: () => makeNode('') },
    window: { addEventListener: (event, handler) => windowHandlers.set(event, handler), confirm: () => { throw new Error('Browser confirmation dialogs are unavailable in this webview'); } }
  }, { filename: 'rendered-chat-webview.js' });
  assert.equal(messages[0].type, 'ready');
  for(const name of ['OpenRouter', 'Groq', 'Google Gemini', 'Mistral']) {
    assert.ok(panels[0].webview.html.includes(name));
  }
  windowHandlers.get('message')({ data: { type: 'sessionList', activeId: 'one', sessions: [{ id: 'one', title: 'First chat' }] } });
  assert.equal(element('chatTitle').textContent, 'First chat');
  element('sessionList').children[0].children[0].onclick();
  assert.equal(messages.at(-1).type, 'switchSession');
  let deletionClickStopped = false;
  element('sessionList').children[0].children[1].onclick({ stopPropagation() { deletionClickStopped = true; } });
  assert.equal(deletionClickStopped, true);
  assert.equal(messages.at(-1).type, 'deleteSession');
  assert.equal(messages.at(-1).id, 'one');
  element('prompt').value = 'Private draft';
  windowHandlers.get('message')({ data: { type: 'sessionState', messages: [] } });
  assert.equal(element('prompt').value, '');
  assert.equal(element('contextMenu').hidden, true);
  assert.match(panels[0].webview.html, /id="contextRing"[^>]*role="progressbar"/);
  windowHandlers.get('message')({ data: { type: 'contextUsage', estimatedTokens: 2048, contextLength: 8192, model: 'test-model' } });
  assert.equal(element('contextUsageText').textContent, '25%');
  assert.match(element('contextRing').style.background, /25%/);
  assert.match(element('contextMeter').title, /2,048 \/ 8,192 tokens/);
  windowHandlers.get('message')({ data: { type: 'contextUsage', estimatedTokens: 9000, contextLength: 8192, model: 'test-model' } });
  assert.equal(element('contextUsageText').textContent, '100%');
  windowHandlers.get('message')({ data: { type: 'contextUsage', estimatedTokens: 500, model: 'unknown-model' } });
  assert.equal(element('contextUsageText').textContent, '?');
  assert.match(element('contextMeter').title, /Context limit unavailable/);
  windowHandlers.get('message')({ data: { type: 'filesSelected', files: ['src/main.ts'] } });
  assert.equal(element('attachments').children.length, 1);
  element('contextBtn').onclick();
  assert.equal(element('contextMenu').hidden, false);
  element('attachFolder').onclick();
  assert.equal(messages.at(-1).type, 'pickFolder');
  element('attachProblems').onclick();
  assert.equal(element('attachments').children.length, 2);
  windowHandlers.get('message')({ data: { type: 'contextSelected', context: { kind: 'folder', path: 'src', label: 'src' } } });
  assert.equal(element('attachments').children.length, 3);
  windowHandlers.get('message')({ data: { type: 'checkpointCount', count: 1 } });
  element('restoreEdit').onclick();
  assert.equal(messages.at(-1).type, 'restoreEdit');
  handlers.get('settingsBtn:click')();
  assert.equal(element('settings').classList.contains('open'), true);
  handlers.get('closeSettings:click')();
  assert.equal(element('settings').classList.contains('open'), false);
  element('agentsBtn').onclick();
  assert.equal(messages.at(-1).type, 'openAgents');
  element('headerNew').onclick();
  assert.equal(messages.at(-1).type, 'clear');
  element('reviewBtn').onclick();
  assert.equal(messages.at(-1).type, 'openChanges');
  element('attachFile').onclick();
  assert.equal(messages.at(-1).type, 'pickFiles');
  element('addSelection').onclick();
  assert.equal(messages.at(-1).type, 'readSelection');
  element('saveSettings').onclick();
  assert.equal(messages.at(-1).type, 'saveSettings');
  element('approvalMode').value = 'autoAll';
  element('saveSettings').onclick();
  assert.equal(messages.at(-1).settings.approvalMode, 'autoAll');
  element('quickApproval').value = 'autoEdits';
  element('quickApproval').onchange();
  assert.equal(messages.at(-1).settings.approvalMode, 'autoEdits');
  element('refreshModels').onclick();
  assert.equal(messages.at(-1).type, 'refreshModels');
  assert.match(panels[0].webview.html, /id="chatMode"[\s\S]*id="modelPicker"[\s\S]*id="providersBtn"/);
  assert.match(panels[0].webview.html, /id="workingModel"[^>]*role="status"/);
  assert.ok(!panels[0].webview.html.includes('id="model"'), 'settings model dropdown is removed');
  assert.ok(!panels[0].webview.html.includes('id="simpleModel"'), 'tier model controls are removed');
  element('providersBtn').onclick();
  assert.equal(element('settings').classList.contains('open'), true);
  windowHandlers.get('message')({ data: { type: 'settingsSaved', settings: { mode: 'agent', approvalMode: 'autoEdits' }, hasKeys: { openrouter: true, groq: true, gemini: false, mistral: false } } });
  assert.equal(element('providersBtn').textContent, 'Providers (2)');
  windowHandlers.get('message')({ data: { type: 'models', provider: 'openrouter', models: [{ id: 'first-free' }, { id: 'second-free' }] } });
  assert.match(element('openrouterKeyStatus').textContent, /2 models available/);
  element('saveSettings').onclick();
  assert.equal(messages.at(-1).settings.autoMode, true);
  assert.equal(messages.at(-1).settings.adaptiveRouting, true);
  assert.equal(messages.at(-1).settings.model, undefined);
  for (const [provider, model] of [['groq', 'groq-model'], ['gemini', 'gemini-3.8-flash'], ['mistral', 'codestral-latest']]) {
    windowHandlers.get('message')({ data: { type: 'models', provider, models: [{ id: model }] } });
    assert.ok(element('modelPicker').options.some(option => option.value === JSON.stringify([provider, model])));
  }
  element('modelPicker').value = JSON.stringify(['gemini', 'gemini-3.8-flash']);
  element('modelPicker').onchange();
  assert.equal(messages.at(-1).type, 'saveSettings');
  assert.equal(messages.at(-1).settings.modelOverride.provider, 'gemini');
  assert.equal(messages.at(-1).settings.modelOverride.model, 'gemini-3.8-flash');
  assert.match(element('workingModel').textContent, /Google Gemini.*gemini-3.8-flash/);
  element('modelPicker').value = '';
  element('modelPicker').onchange();
  assert.equal(messages.at(-1).settings.modelOverride, undefined);
  assert.match(element('workingModel').textContent, /Auto/);
  element('prompt').value = 'Hello';
  element('send').onclick();
  assert.equal(messages.at(-1).type, 'send');
  assert.equal(messages.at(-1).text, 'Hello');
  assert.equal(messages.at(-1).files[0], 'src/main.ts');
  assert.equal(messages.at(-1).extras.length, 2);
  element('stop').onclick();
  assert.equal(messages.at(-1).type, 'stop');
  windowHandlers.get('message')({ data: { type: 'startAssistant', provider: 'openrouter', model: 'demo' } });
  assert.match(element('workingModel').textContent, /Working model:.*demo/);
  assert.equal(element('modelPicker').disabled, true);
  windowHandlers.get('message')({ data: { type: 'modelChanged', provider: 'groq', model: 'backup-model' } });
  assert.match(element('workingModel').textContent, /Working model:.*Groq.*backup-model/);
  assert.match(element('messages').children.at(-1).children.find(child => child.className === 'routing').textContent, /Groq.*backup-model.*continued/);
  const terminalActivity = { id: 'terminal-one', kind: 'terminal', title: '$ npm test', command: 'npm test', detail: 'Running tests', status: 'running', startedAt: Date.now() };
  windowHandlers.get('message')({ data: { type: 'activity', activity: terminalActivity } });
  let terminalCard = element('messages').children.at(-1).children.find(child => child.className === 'activity-card');
  assert.equal(terminalCard.open, true);
  terminalCard.children[1].children[1].children[0].onclick();
  assert.equal(messages.at(-1).type, 'focusTerminal');
  terminalCard.children[1].children[1].children[1].onclick();
  assert.equal(messages.at(-1).text, 'npm test');
  terminalCard.children[1].children[1].children[2].onclick();
  assert.equal(messages.at(-1).type, 'stop');
  windowHandlers.get('message')({ data: { type: 'activity', activity: { ...terminalActivity, detail: 'Exit: 0\nTests passed', status: 'complete', finishedAt: Date.now() } } });
  assert.equal(element('messages').children.at(-1).children.filter(child => child.className === 'activity-card').length, 1, 'streaming updates reuse the existing card');
  assert.match(terminalCard.children[1].children[0].textContent, /Tests passed/);
  assert.equal(terminalCard.children[1].children[1].children.length, 2, 'completed command removes Stop run');
  windowHandlers.get('message')({ data: { type: 'contextSources', paths: ['src/main.ts'], mappedFiles: 12 } });
  assert.match(element('messages').children.at(-1).children.find(child => child.textContent?.startsWith('Context:')).textContent, /src\/main\.ts/);
  windowHandlers.get('message')({ data: { type: 'finish', text: '### Result\n```ts\nconst answer = 42;\n```' } });
  assert.equal(element('modelPicker').disabled, false);
  assert.match(element('workingModel').textContent, /^Model:.*backup-model/);
  const reply = element('messages').children.at(-1);
  const content = reply.children.find(child => child.className === 'content');
  const codeBlock = content.children.find(child => child.className === 'code-block');
  assert.ok(codeBlock);
  codeBlock.children[0].children[1].onclick();
  assert.equal(messages.at(-1).text, 'const answer = 42;');
  reply.children.at(-1).children.at(-1).onclick();
  assert.equal(messages.at(-1).type, 'copy');
});

test('auto routing uses the configured provider and Ask mode limits tools', async () => {
  const commands = new Map();
  const requests = [];
  const posted = [];
  let receive;
  const vscode = {
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
    window: { registerWebviewViewProvider(id, provider) { const view = this.createWebviewPanel(); view.show = () => {}; provider.resolveWebviewView(view); return { dispose() {} }; }, createWebviewPanel() { return {
      webview: { html: '', postMessage(message) { posted.push(message); }, onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; } },
      onDidDispose() { return { dispose() {} }; }, reveal() {}
    }; } },
    ViewColumn: { One: 1, Beside: 2 },
    Uri: { joinPath: (...parts) => parts.join('/') },
    workspace: { workspaceFolders: [] }
  };
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  Module._load = function(request, ...args) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);
  };
  global.fetch = async (url, init) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: url.includes('groq') ? [{ id: 'groq-model', context_length: 32768 }] : [
      { id: 'main-model', context_length: 32768, pricing: { prompt: '0', completion: '0' } },
      { id: 'paid-model', pricing: { prompt: '0.001', completion: '0.002' } },
      { id: 'paid-output', pricing: { prompt: '0', completion: '0.002' } },
      { id: 'paid-request', pricing: { prompt: '0', completion: '0', request: '0.01' } },
      { id: 'unknown:free' },
      { id: 'missing-output', pricing: { prompt: '0' } },
      { id: 'blank-pricing', pricing: { prompt: '', completion: '' } }
    ] }));
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response('data: {"choices":[{"delta":{"content":"Done."}}]}\n\ndata: [DONE]\n\n');
  };
  try {
    delete require.cache[require.resolve('../out/extension.js')];
    const extension = require('../out/extension.js');
    extension.activate({
      extensionUri: 'extension', subscriptions: [],
      globalState: { get() {}, async update() {} },
      workspaceState: { get() {}, async update() {} },
      secrets: { async get() { return 'test-key'; }, async store() {} }
    });
    commands.get('routerChat.openChat')();
    await receive({ type: 'loadModels', provider: 'groq' });
    await receive({ type: 'loadModels', provider: 'openrouter' });
    assert.deepEqual(posted.findLast(message => message.type === 'models' && message.provider === 'openrouter').models.map(model => model.id), ['main-model']);
    assert.deepEqual(posted.findLast(message => message.type === 'models' && message.provider === 'groq').models.map(model => model.id), ['groq-model']);
    const settings = {
      provider: 'openrouter', model: 'main-model', mode: 'ask', autoMode: true,
      simpleProvider: 'openrouter', simpleModel: '',
      mediumProvider: 'openrouter', mediumModel: '',
      complexProvider: 'groq', complexModel: 'groq-model'
    };
    await receive({ type: 'send', settings, text: 'Refactor the entire project architecture' });
    assert.match(requests[0].url, /api\.groq\.com/);
    assert.equal(requests[0].body.model, 'groq-model');
    assert.equal(requests[0].body.tools.length, 5);
    assert.equal(posted.findLast(message => message.type === 'contextUsage').contextLength, 32768);
    assert.equal(posted.findLast(message => message.type === 'contextUsage').model, 'groq-model');

    await receive({ type: 'send', settings: { ...settings, autoMode: false, mode: 'agent' }, text: 'Hello' });
    assert.match(requests[1].url, /openrouter\.ai/);
    assert.equal(requests[1].body.model, 'main-model');
    assert.equal(requests[1].body.tools.length, 12);
    assert.equal(posted.findLast(message => message.type === 'contextUsage').model, 'main-model');
    assert.equal(posted.findLast(message => message.type === 'contextUsage').contextLength, 32768);
    for (let index = 0; index < 14; index++) {
      await receive({ type: 'send', settings: { ...settings, autoMode: false, mode: 'ask' }, text: `Follow-up ${index}: ` + 'context details '.repeat(540) });
    }
    const compacted = requests.at(-1).body.messages;
    assert.ok(JSON.stringify(compacted).length < 32768 * 4 * 0.7, 'model input stays below the context budget');
    assert.match(compacted.find(message => message.content?.startsWith('Earlier conversation (abridged):'))?.content || '', /Refactor the entire project architecture/, 'initial goal survives compaction');
    assert.match(compacted.at(-1).content, /Follow-up 13:/, 'latest user request survives compaction');
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
  }
});

test('chat sessions persist and Plan mode stays read-only', async () => {
  const commands = new Map();
  const posted = [];
  const state = new Map();
  const requests = [];
  let receive;
  const vscode = {
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
    window: { registerWebviewViewProvider(id, provider) { const view = this.createWebviewPanel(); view.show = () => {}; provider.resolveWebviewView(view); return { dispose() {} }; }, createWebviewPanel() { return {
      webview: { html: '', postMessage(message) { posted.push(message); }, onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; } },
      onDidDispose() { return { dispose() {} }; }, reveal() {}
    }; } },
    ViewColumn: { One: 1, Beside: 2 },
    Uri: { joinPath: (...parts) => parts.join('/') },
    workspace: { workspaceFolders: [] }
  };
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  Module._load = function(request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };
  global.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"A plan."}}]}\n\ndata: [DONE]\n\n');
  };
  try {
    delete require.cache[require.resolve('../out/extension.js')];
    require('../out/extension.js').activate({
      extensionUri: 'extension', subscriptions: [],
      globalState: { get() {}, async update() {} },
      workspaceState: { get: key => state.get(key), async update(key, value) { state.set(key, value); } },
      secrets: { async get() { return 'test-key'; }, async store() {} }
    });
    commands.get('routerChat.openChat')();
    await receive({ type: 'ready' });
    const firstId = posted.find(message => message.type === 'sessionList').activeId;
    await receive({ type: 'send', text: 'Plan a feature', settings: { provider: 'openrouter', model: 'test-model', mode: 'plan' } });
    assert.equal(requests[0].tools.length, 5);
    assert.equal(state.get('routerChat.sessions')[0].messages.length, 2);
    await receive({ type: 'clear' });
    assert.equal(state.get('routerChat.sessions').length, 2);
    await receive({ type: 'switchSession', id: firstId });
    assert.equal(posted.findLast(message => message.type === 'sessionState').messages[0].display, 'Plan a feature');
    assert.equal(posted.at(-1).type, 'contextUsage');
    const secondId = state.get('routerChat.sessions').find(session => session.id !== firstId).id;
    state.set('routerChat.checkpoints', [
      { id: 'owned', sessionId: firstId, beforeBase64: 'private-file-copy' },
      { id: 'other', sessionId: secondId, beforeBase64: 'other-file-copy' },
      { id: 'legacy', beforeBase64: 'old-unattributed-copy' }
    ]);
    await receive({ type: 'ready' });
    await receive({ type: 'deleteSession', id: firstId });
    assert.ok(state.get('routerChat.sessions').every(session => session.id !== firstId));
    assert.equal(state.get('routerChat.activeSessionId'), secondId);
    assert.deepEqual(state.get('routerChat.checkpoints').map(checkpoint => checkpoint.id), ['other']);
    assert.deepEqual(posted.findLast(message => message.type === 'sessionState').messages, []);
    await receive({ type: 'ready' });
    assert.ok(posted.findLast(message => message.type === 'sessionList').sessions.every(session => session.id !== firstId), 'deleted history stays deleted after reload');

    let started;
    const requestStarted = new Promise(resolve => { started = resolve; });
    global.fetch = async (_url, options) => {
      started();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new Error('Request aborted'));
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    };
    const sending = receive({ type: 'send', text: 'Private in-flight prompt', settings: { provider: 'openrouter', model: 'test-model', mode: 'ask' } });
    await requestStarted;
    await receive({ type: 'deleteSession', id: secondId });
    await sending;
    assert.equal(state.get('routerChat.sessions').length, 1);
    assert.notEqual(state.get('routerChat.activeSessionId'), secondId);
    assert.deepEqual(state.get('routerChat.sessions')[0].messages, []);
    assert.deepEqual(state.get('routerChat.checkpoints'), []);
    assert.ok(!JSON.stringify(state.get('routerChat.sessions')).includes('Private in-flight prompt'), 'aborted request cannot recreate deleted chat data');
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
  }
});

test('workspace file attachments reach the model with visible file references', async () => {
  const commands = new Map();
  const posted = [];
  const state = new Map();
  let receive;
  let request;
  class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
  const folder = { name: 'repo', uri: { path: '/workspace', scheme: 'file', fsPath: '/workspace' } };
  const vscode = {
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
    window: {
      registerWebviewViewProvider(id, provider) { const view = this.createWebviewPanel(); view.show = () => {}; provider.resolveWebviewView(view); return { dispose() {} }; },
      createWebviewPanel() { return {
        webview: { html: '', postMessage(message) { posted.push(message); }, onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; } },
        onDidDispose() { return { dispose() {} }; }, reveal() {}
      }; },
      async showQuickPick(items, options) { return options.canPickMany ? items.slice(0, 1) : items.find(item => item.path === 'src'); }
    },
    ViewColumn: { One: 1, Beside: 2 },
    Uri: { joinPath: (uri, part) => ({ path: `${uri.path}/${part}`, scheme: 'file', fsPath: `${uri.fsPath}/${part}` }) },
    RelativePattern: class { constructor(folder, pattern) { this.folder = folder; this.pattern = pattern; } },
    FileType: { File: 1, SymbolicLink: 64 }, FileSystemError,
    languages: { getDiagnostics() { return [[{ path: '/workspace/src/main.ts' }, [{ severity: 0, range: { start: { line: 2, character: 4 } }, message: 'Example error' }]]]; } },
    workspace: {
      workspaceFolders: [folder],
      getWorkspaceFolder() { return folder; },
      async findFiles(pattern) { return pattern.pattern === '**/*' ? [{ path: '/workspace/src/main.ts', scheme: 'file' }] : []; },
      asRelativePath: uri => uri.path.replace('/workspace/', ''),
      fs: {
        async stat(uri) { if (uri.path === '/workspace/src' || uri.path === '/workspace/src/main.ts') return { type: 1 }; throw new FileSystemError('FileNotFound'); },
        async readFile(uri) { if (uri.path === '/workspace/src/main.ts') return Buffer.from('export const value = 42;'); throw new FileSystemError('FileNotFound'); },
        async readDirectory() { return [['main.ts', 1]]; }
      }
    }
  };
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
  global.fetch = async (url, init) => {
    request = JSON.parse(init.body);
    return new Response('data: {"choices":[{"delta":{"content":"Done."}}]}\n\ndata: [DONE]\n\n');
  };
  try {
    delete require.cache[require.resolve('../out/extension.js')];
    require('../out/extension.js').activate({
      extensionUri: folder.uri, subscriptions: [],
      globalState: { get() {}, async update() {} },
      workspaceState: { get: key => state.get(key), async update(key, value) { state.set(key, value); } },
      secrets: { async get() { return 'test-key'; }, async store() {} }
    });
    commands.get('routerChat.openChat')();
    await receive({ type: 'pickFiles' });
    assert.deepEqual(posted.at(-1).files, ['src/main.ts']);
    await receive({ type: 'pickFolder' });
    assert.equal(posted.at(-1).context.path, 'src');
    await receive({ type: 'send', text: 'Explain this', files: ['src/main.ts'], extras: [{ kind: 'folder', path: 'src', label: 'src' }, { kind: 'diagnostics', label: 'Problems' }], settings: { provider: 'openrouter', model: 'test-model', mode: 'ask' } });
    assert.match(request.messages.at(-1).content, /export const value = 42/);
    assert.match(request.messages.at(-1).content, /Folder: src/);
    assert.match(request.messages.at(-1).content, /Example error/);
    assert.match(state.get('routerChat.sessions')[0].messages[0].display, /Attached: src\/main\.ts/);
    vscode.window.activeTextEditor = { document: { uri: { path: '/workspace/src/main.ts', scheme: 'file' }, isDirty: true, getText() { return 'export const unsavedBuffer = 99;'; } } };
    await receive({ type: 'send', text: 'Explain unsavedBuffer', settings: { provider: 'openrouter', model: 'test-model', mode: 'ask' } });
    assert.match(request.messages.find(message => message.role === 'system' && message.content.includes('Active editor:'))?.content || '', /Active editor: src\/main\.ts \(unsaved changes\)[\s\S]*unsavedBuffer/);
    assert.equal(state.get('routerChat.sessions')[0].messages.at(-2).content, 'Explain unsavedBuffer', 'automatic excerpts are refreshed, not saved in chat history');
    vscode.window.activeTextEditor = undefined;
    await receive({ type: 'send', text: 'Where is value defined?', settings: { provider: 'openrouter', model: 'test-model', mode: 'ask' } });
    assert.match(request.messages.find(message => message.role === 'system' && message.content.includes('Relevant file:'))?.content || '', /Relevant file: src\/main\.ts[\s\S]*value = 42/);
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
  }
});

test('approved file edit creates a checkpoint that can restore the prior contents', async () => {
  const commands = new Map();
  const state = new Map();
  const posted = [];
  const executedCommands = [];
  const requests = [];
  const terminalOptions = [];
  const endListeners = new Set();
  let agentTerminal;
  let terminalShows = 0;
  let receive;
  let file = Buffer.from('before');
  let filePath = '/workspace/src/main.ts';
  const directories = new Set(['/workspace/src']);
  let documentCount = 0;
  let requestCount = 0;
  let approvalPrompts = 0;
  class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
  const folder = { name: 'repo', uri: { path: '/workspace', scheme: 'file', fsPath: process.cwd() } };
  const vscode = {
    commands: {
      registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; },
      async executeCommand() {}
    },
    window: {
      registerWebviewViewProvider(id, provider) { const view = this.createWebviewPanel(); view.show = () => {}; provider.resolveWebviewView(view); return { dispose() {} }; },
      createWebviewPanel() { return {
        webview: { html: '', postMessage(message) { posted.push(message); }, onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; } },
        onDidDispose() { return { dispose() {} }; }, reveal() {}
      }; },
      createTerminal(options) {
        terminalOptions.push(options);
        if (options.pty) {
          return { show(preserveFocus) { assert.equal(preserveFocus, true); terminalShows++; options.pty.open(); }, dispose() { options.pty.close(); } };
        }
        agentTerminal = {
          show(preserveFocus) { assert.equal(preserveFocus, true); terminalShows++; }, sendText(command) { executedCommands.push({ command, fallback: true }); }, dispose() {},
          shellIntegration: {
            executeCommand(command) {
              executedCommands.push({ command });
              const execution = { async *read() { yield 'v99.0.0'; } };
              queueMicrotask(() => { for (const listener of endListeners) listener({ execution, exitCode: 0 }); });
              return execution;
            }
          }
        };
        return agentTerminal;
      },
      onDidEndTerminalShellExecution(listener) { endListeners.add(listener); return { dispose() { endListeners.delete(listener); } }; },
      onDidCloseTerminal() { return { dispose() {} }; },
      async showWarningMessage(message, options, choice) { approvalPrompts++; return choice; },
      async showQuickPick(items) { return items[0]; }
    },
    ViewColumn: { One: 1, Beside: 2 },
    Uri: { joinPath: (uri, part) => ({ path: `${uri.path}/${part}`, scheme: 'file', fsPath: `${uri.fsPath}/${part}`, toString() { return this.path; } }) },
    RelativePattern: class { constructor(folder, pattern) { this.folder = folder; this.pattern = pattern; } },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 }, FileSystemError,
    EventEmitter: class {
      constructor() { this.emitter = new EventEmitter(); this.event = listener => { this.emitter.on('fire', listener); return { dispose: () => this.emitter.off('fire', listener) }; }; }
      fire(value) { this.emitter.emit('fire', value); }
      dispose() { this.emitter.removeAllListeners(); }
    },
    workspace: {
      workspaceFolders: [folder],
      async findFiles() { return file ? [{ path: filePath, scheme: 'file' }] : []; }, asRelativePath: uri => uri.path.replace('/workspace/', ''),
      async openTextDocument() { return { uri: { path: `/scratch/${++documentCount}` } }; },
      fs: {
        async stat(uri) { if (directories.has(uri.path)) return { type: 2 }; if (uri.path === filePath && file) return { type: 1 }; throw new FileSystemError('FileNotFound'); },
        async readFile(uri) { if (uri.path === filePath && file) return file; throw new FileSystemError('FileNotFound'); },
        async readDirectory(uri) { if (uri.path === '/workspace') return [['src', 2]]; if (uri.path === '/workspace/src') return file ? [['main.ts', 1]] : []; return []; },
        async createDirectory(uri) { directories.add(uri.path); },
        async writeFile(uri, bytes) { filePath = uri.path; file = Buffer.from(bytes); },
        async rename(source, target) { assert.equal(source.path, filePath); filePath = target.path; },
        async delete(uri) { if (uri.path === filePath) file = undefined; else directories.delete(uri.path); }
      }
    }
  };
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  Module._load = function(name, ...args) {
    if (name === 'vscode') return vscode;
    if (name === 'node:child_process') return { spawn(command, options) {
      assert.equal(options.shell, true);
      assert.equal(options.cwd, folder.uri.fsPath);
      executedCommands.push({ command, captured: true });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write() {} };
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(command === 'echo retry' ? 'verification passed\n' : 'fallback output\n'));
        child.emit('close', command === 'echo retry' ? 0 : 1);
      });
      return child;
    } };
    return originalLoad.call(this, name, ...args);
  };
  global.fetch = async (_url, options) => {
    requestCount++;
    requests.push(JSON.parse(options.body));
    if (requestCount === 1 || requestCount === 3) {
      const args = JSON.stringify({ path: 'src/main.ts', content: 'after', reason: 'test edit' });
      const event = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'propose_file_change', arguments: args } }] } }] });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`);
    }
    if (requestCount === 5) {
      const args = JSON.stringify({ command: 'node --version', reason: 'test command' });
      const event = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call2', function: { name: 'run_terminal_command', arguments: args } }] } }] });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`);
    }
    if (requestCount === 17) {
      const args = JSON.stringify({ command: 'echo fallback', reason: 'test unsupported shell integration' });
      const event = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call15', function: { name: 'run_terminal_command', arguments: args } }] } }] });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`);
    }
    if (requestCount === 18) {
      const args = JSON.stringify({ path: 'src/main.ts', content: 'fixed', reason: 'fix the failed command' });
      const event = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call16', function: { name: 'propose_file_change', arguments: args } }] } }] });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`);
    }
    if (requestCount === 19) {
      const args = JSON.stringify({ command: 'echo retry', reason: 'verify the fix' });
      const event = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call17', function: { name: 'run_terminal_command', arguments: args } }] } }] });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`);
    }
    if ([21, 23, 25].includes(requestCount)) {
      const action = {
        21: ['find_workspace_files', { query: 'MAIN' }],
        23: ['read_file', { path: 'src/main.ts', startLine: 1, endLine: 1 }],
        25: ['search_workspace', { query: 'FIXED' }]
      }[requestCount];
      const event = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call${requestCount}`, function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } }] });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`);
    }
    if ([7, 9, 11, 13, 15].includes(requestCount)) {
      const action = {
        7: ['create_directory', { path: 'generated', reason: 'test directory' }],
        9: ['move_workspace_path', { path: 'src/main.ts', destination: 'generated/main.ts', reason: 'test move' }],
        11: ['replace_in_file', { path: 'generated/main.ts', oldText: 'after', newText: 'replaced', reason: 'test targeted edit' }],
        13: ['delete_workspace_path', { path: 'generated/main.ts', reason: 'test delete file' }],
        15: ['delete_workspace_path', { path: 'generated', reason: 'test delete directory' }]
      }[requestCount];
      const event = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call${requestCount}`, function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } }] });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`);
    }
    return new Response('data: {"choices":[{"delta":{"content":"Edited."}}]}\n\ndata: [DONE]\n\n');
  };
  try {
    delete require.cache[require.resolve('../out/extension.js')];
    require('../out/extension.js').activate({
      extensionUri: folder.uri, subscriptions: [],
      globalState: { get() {}, async update() {} },
      workspaceState: { get: key => state.get(key), async update(key, value) { state.set(key, value); } },
      secrets: { async get() { return 'test-key'; }, async store() {} }
    });
    commands.get('routerChat.openChat')();
    await receive({ type: 'send', text: 'Edit this file', settings: { provider: 'openrouter', model: 'test-model', mode: 'agent' } });
    assert.equal(file.toString(), 'after');
    assert.equal(approvalPrompts, 1);
    assert.equal(documentCount, 2);
    assert.equal(state.get('routerChat.checkpoints').length, 1);
    await receive({ type: 'restoreEdit' });
    assert.equal(file.toString(), 'before');
    assert.equal(state.get('routerChat.checkpoints').length, 0);
    assert.equal(approvalPrompts, 2, 'restore asks before reverting a file');
    await receive({ type: 'send', text: 'Edit automatically', settings: { provider: 'openrouter', model: 'test-model', mode: 'agent', approvalMode: 'autoEdits' } });
    assert.equal(file.toString(), 'after');
    assert.equal(approvalPrompts, 2, 'automatic edits do not prompt');
    assert.equal(documentCount, 2, 'automatic edits do not open a diff');
    await receive({ type: 'send', text: 'Run a command automatically', settings: { provider: 'openrouter', model: 'test-model', mode: 'agent', approvalMode: 'autoAll' } });
    assert.equal(requestCount, 6, 'agent returns after the terminal tool');
    assert.equal(approvalPrompts, 2, 'automatic command approval does not prompt');
    assert.equal(executedCommands[0].command, 'node --version');
    assert.equal(terminalOptions[0].cwd, folder.uri);
    assert.equal(terminalShows, 1);
    assert.match(posted.findLast(message => message.type === 'activity' && message.activity.kind !== 'thinking').activity.detail, /Exit: 0[\s\S]*v99\.0\.0/);
    const autoSettings = { provider: 'openrouter', model: 'test-model', mode: 'agent', approvalMode: 'autoAll' };
    await receive({ type: 'send', text: 'Create directory', settings: autoSettings });
    assert.ok(directories.has('/workspace/generated'));
    await receive({ type: 'send', text: 'Move file', settings: autoSettings });
    assert.equal(filePath, '/workspace/generated/main.ts');
    await receive({ type: 'send', text: 'Replace one span', settings: autoSettings });
    assert.equal(file.toString(), 'replaced');
    await receive({ type: 'send', text: 'Delete file', settings: autoSettings });
    assert.equal(file, undefined);
    await receive({ type: 'send', text: 'Delete empty directory', settings: autoSettings });
    assert.equal(directories.has('/workspace/generated'), false);
    assert.equal(approvalPrompts, 2, 'automatic workspace actions do not prompt');
    agentTerminal.shellIntegration = undefined;
    await receive({ type: 'send', text: 'Run in terminal without shell integration', settings: autoSettings });
    assert.deepEqual(executedCommands[1], { command: 'echo fallback', captured: true });
    assert.deepEqual(executedCommands[2], { command: 'echo retry', captured: true });
    assert.equal(terminalOptions.length, 2, 'fallback creates a visible captured terminal');
    assert.match(requests[17].messages.at(-1).content, /Exit: 1[\s\S]*fallback output/, 'failed terminal output reaches the next model turn');
    assert.equal(file.toString(), 'fixed', 'agent can edit after reading the command failure');
    assert.match(requests[19].messages.at(-1).content, /Exit: 0[\s\S]*verification passed/, 'successful rerun reaches the next model turn');
    assert.match(posted.findLast(message => message.type === 'activity' && message.activity.kind !== 'thinking').activity.detail, /Exit: 0[\s\S]*verification passed/);
    await receive({ type: 'send', text: 'Find the file', settings: autoSettings });
    assert.match(posted.findLast(message => message.type === 'activity' && message.activity.kind !== 'thinking').activity.detail, /src\/main\.ts/);
    await receive({ type: 'send', text: 'Read a line', settings: autoSettings });
    assert.match(posted.findLast(message => message.type === 'activity' && message.activity.kind !== 'thinking').activity.detail, /1: fixed/);
    await receive({ type: 'send', text: 'Search regardless of case', settings: autoSettings });
    assert.match(posted.findLast(message => message.type === 'activity' && message.activity.kind !== 'thinking').activity.detail, /src\/main\.ts:1: fixed/);
    const deletedId = state.get('routerChat.activeSessionId');
    assert.ok(state.get('routerChat.checkpoints').every(checkpoint => checkpoint.sessionId === deletedId));
    await receive({ type: 'deleteSession', id: deletedId });
    assert.deepEqual(state.get('routerChat.checkpoints'), []);
    assert.equal(posted.findLast(message => message.type === 'checkpointCount').count, 0);
    assert.equal(file.toString(), 'fixed', 'deleting chat data preserves project files');
    await receive({ type: 'send', text: 'Inspect terminal context', extras: [{ kind: 'terminal' }], settings: autoSettings });
    assert.match(requests.at(-1).messages.find(message => message.role === 'user').content, /no agent terminal command yet/);
    assert.ok(!JSON.stringify(requests.at(-1).messages).includes('verification passed'), 'deleted terminal output is not reused');
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
  }
});


function orchestrationHarness(fetchHandler, config = {}) {
  const posted = [], requests = [], commands = new Map(), state = new Map(), globals = new Map(), secrets = new Map(Object.entries(config.keys || Object.fromEntries(['openrouter', 'groq', 'gemini', 'mistral'].map(id => ['routerChat.' + id + '.apiKey', 'test-key'])))), catalogRequests = [];
  let receive;
  const vscode = {
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; }, async executeCommand() {} },
    window: { registerWebviewViewProvider(_id, provider) {
      provider.resolveWebviewView({ show() {}, onDidDispose() {}, webview: { html: '', postMessage(message) { posted.push(structuredClone(message)); }, onDidReceiveMessage(handler) { receive = handler; } } });
      return { dispose() {} };
    } },
    workspace: { workspaceFolders: [] },
    Uri: { joinPath: (...parts) => parts.join('/') }
  };
  const originalLoad = Module._load, originalFetch = global.fetch;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
  global.fetch = async (url, options) => { if (url.endsWith('/models')) { const provider = url.includes('groq') ? 'groq' : url.includes('googleapis') ? 'gemini' : url.includes('mistral') ? 'mistral' : 'openrouter'; catalogRequests.push({ provider, url, options }); if(config.catalogErrors?.[provider])return new Response('Catalog unavailable', {status:503}); return new Response(JSON.stringify({ data: config.catalogs?.[provider] || [] })); } const body = JSON.parse(options.body); requests.push(body); return fetchHandler(body, options, url); };
  delete require.cache[require.resolve('../out/extension.js')];
  require('../out/extension.js').activate({ extensionUri: 'extension', subscriptions: [], globalState: { get: key => globals.get(key), async update(key,value) { globals.set(key,structuredClone(value)); } }, workspaceState: { get: key => state.get(key), async update(key, value) { state.set(key, structuredClone(value)); } }, secrets: { async get(name) { return secrets.get(name); }, async store(name,value) { secrets.set(name,value); } } });
  return { posted, requests, state, globals, secrets, catalogRequests, receive: message => receive(message), restore() { Module._load = originalLoad; global.fetch = originalFetch; } };
}
function streamed(content, tools) {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content, ...(tools ? { tool_calls: tools } : {}) } }] }) + '\n\ndata: [DONE]\n\n');
}
function toolCall(name, args, id = 'task-call') { return { index: 0, id, function: { name, arguments: JSON.stringify(args) } }; }

test('complex tasks launch parallel specialists, enforce worker permissions and budget, and return findings to the coordinator', async () => {
  const workerTurns = new Map();
  let inFlight = 0, peak = 0, parentTurns = 0;
  const gates = [];
  const harness = orchestrationHarness(async body => {
    const specialist = body.messages.some(message => message.content?.includes('You are a read-only specialist sub-agent.'));
    if (specialist) {
      assert.equal(body.tools.length, 5);
      assert.ok(body.tools.every(tool => !['run_terminal_command', 'delegate_tasks', 'propose_file_change'].includes(tool.function.name)));
      const task = body.messages.find(message => message.role === 'user').content;
      const turn = (workerTurns.get(task) || 0) + 1; workerTurns.set(task, turn);
      if (turn === 1) {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(resolve => { gates.push(resolve); if (gates.length === (workerTurns.size <= 2 ? 2 : 3)) { for (const release of gates.splice(0)) release(); } });
        inFlight--;
        if (task.startsWith('Independently inspect')) return new Response('worker unavailable', { status: 503 });
        return streamed('', [toolCall('run_terminal_command', { command: 'should-never-run', reason: 'permission probe' })]);
      }
      assert.match(body.messages.at(-1).content, /Tool denied: this mode is read-only/);
      return streamed('Worker findings: inspect src/extension.ts and run npm test.');
    }
    assert.ok(body.tools.some(tool => tool.function.name === 'delegate_tasks'));
    parentTurns++;
    if (parentTurns === 1) return streamed('I will inspect the implementation and risks.');
    if (parentTurns === 2) {
      assert.match(body.messages.find(message => message.content?.includes('Sub-agent findings'))?.content || '', /Worker findings/);
      assert.match(body.messages.find(message => message.content?.includes('Sub-agent findings'))?.content || '', /Failed: Provider returned 503/);
      return streamed('', [toolCall('delegate_tasks', { tasks: [1, 2, 3].map(index => ({ title: 'Review ' + index, task: 'Independent review ' + index })) })]);
    }
    if (parentTurns === 3) {
      assert.match(body.messages.at(-1).content, /Worker findings/);
      return streamed('', [toolCall('delegate_tasks', { tasks: [1, 2].map(index => ({ title: 'Extra ' + index, task: 'Extra task ' + index })) }, 'over-budget')]);
    }
    assert.match(body.messages.at(-1).content, /Worker limit reached/);
    return streamed('Implemented using the specialist findings.');
  });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Refactor the entire project architecture', settings: { provider: 'openrouter', model: 'free-model', mode: 'agent' } });
    assert.equal(workerTurns.size, 5);
    assert.ok(harness.posted.filter(message => message.type === 'delta').every(message => !message.text.includes('Worker findings')), 'specialist output does not leak into the coordinator reply');
    assert.equal(peak, 3, 'worker requests run concurrently with at most three per batch');
    assert.equal(parentTurns, 4);
    const activities = harness.state.get('routerChat.sessions')[0].messages.at(-1).activities;
    assert.equal(activities.filter(activity => activity.kind === 'agent').length, 5);
    assert.ok(activities.some(activity => activity.kind === 'agent' && activity.status === 'failed'));
    assert.ok(activities.every(activity => activity.status !== 'running'), 'failed workers settle their nested thinking activities');
    assert.ok(harness.posted.some(message => message.type === 'finish' && message.text.includes('Implemented')));
  } finally { harness.restore(); }
});

test('Stop cancels every active specialist before the coordinator resumes', async () => {
  let started = 0, aborted = 0, release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  const harness = orchestrationHarness(async (body, options) => {
    if (!body.messages.some(message => message.content?.includes('You are a read-only specialist sub-agent.'))) return streamed('I will inspect the task first.');
    started++; if (started === 2) release();
    return new Promise((_resolve, reject) => {
      const abort = () => { aborted++; reject(new Error('Request stopped.')); };
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
    });
  });
  try {
    await harness.receive({ type: 'ready' });
    const sending = harness.receive({ type: 'send', text: 'Implement feature across the entire project', settings: { provider: 'openrouter', model: 'free-model', mode: 'agent' } });
    await bothStarted;
    await harness.receive({ type: 'stop' });
    await sending;
    assert.equal(started, 2);
    assert.equal(aborted, 2);
    const activities = harness.state.get('routerChat.sessions')[0].messages.at(-1).activities;
    assert.equal(activities.filter(activity => activity.kind === 'agent' && activity.status === 'stopped').length, 2);
    assert.ok(activities.every(activity => activity.status !== 'running'));
  } finally { harness.restore(); }
});


const freeCatalogModel = (id, context_length = 32768) => ({ id, context_length, pricing: { prompt: '0', completion: '0' } });
const fallbackSettings = { provider: 'openrouter', model: 'primary', mode: 'agent', approvalMode: 'autoAll' };

test('rate-limit failover preserves completed tool calls and context without replaying tools', async () => {
  let primaryCalls = 0;
  const harness = orchestrationHarness(async body => {
    if (body.model === 'primary') {
      primaryCalls++;
      if (primaryCalls === 1) return streamed('Checking diagnostics.', [toolCall('read_diagnostics', {}, 'diagnostics-once')]);
      return new Response('rate limit reached', { status: 429 });
    }
    assert.equal(body.model, 'backup');
    assert.equal(body.messages.filter(message => message.role === 'tool').length, 1);
    assert.equal(body.messages.at(-1).tool_call_id, 'diagnostics-once');
    assert.match(body.messages.at(-1).content, /No workspace is open/);
    assert.ok(body.messages.some(message => message.role === 'user' && message.content === 'Fix the validation bug'));
    assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('automatic approval')));
    return streamed('Continued using the diagnostic result.');
  }, { catalogs: { openrouter: [freeCatalogModel('primary'), freeCatalogModel('backup'), { id: 'paid', pricing: { prompt: '0.1', completion: '0.1' } }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Fix the validation bug', settings: fallbackSettings });
    assert.deepEqual(harness.requests.map(request => request.model), ['primary', 'primary', 'backup']);
    assert.equal(harness.posted.filter(message => message.type === 'activity' && message.activity.title === 'Check problems' && message.activity.status === 'complete').length, 1);
    assert.ok(harness.posted.some(message => message.type === 'modelChanged' && message.model === 'backup'));
    assert.equal(harness.posted.findLast(message => message.type === 'contextUsage').model, 'backup');
    assert.match(harness.state.get('routerChat.sessions')[0].messages.at(-1).content, /Continued/);
  } finally { harness.restore(); }
});

test('exhausted credits switch providers with the correct key and preserve the conversation', async () => {
  const harness = orchestrationHarness(async (body, options, url) => {
    if (url.includes('openrouter')) return new Response('Insufficient credits', { status: 402 });
    assert.match(url, /api.groq.com/);
    assert.equal(options.headers.Authorization, 'Bearer groq-test-key');
    assert.equal(body.model, 'groq-backup');
    assert.match(body.messages.find(message => message.role === 'user').content, /Keep the current task/);
    assert.equal(options.headers['HTTP-Referer'], undefined);
    return streamed('Finished on the next provider.');
  }, { keys: { 'routerChat.openrouter.apiKey': 'openrouter-test-key', 'routerChat.groq.apiKey': 'groq-test-key' }, catalogs: { openrouter: [freeCatalogModel('other-openrouter')], groq: [{ id: 'groq-backup', context_length: 32768 }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Keep the current task going', settings: fallbackSettings });
    assert.deepEqual(harness.requests.map(request => request.model), ['primary', 'groq-backup']);
    assert.ok(harness.posted.some(message => message.type === 'finish' && message.text.includes('Finished')));
  } finally { harness.restore(); }
});

test('an interrupted stream carries partial prose forward and discards unexecuted tool fragments', async () => {
  const harness = orchestrationHarness(async body => {
    if (body.model === 'primary') return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'The diagnosis is ', tool_calls: [{ index: 0, id: 'unfinished', function: { name: 'run_terminal_command', arguments: '{"command":' } }] } }] }) + '\n\n');
    assert.equal(body.model, 'backup');
    assert.ok(body.messages.some(message => message.role === 'assistant' && message.content === 'The diagnosis is '));
    assert.match(body.messages.at(-1).content, /No tool calls from the interrupted response were executed/);
    assert.ok(!body.messages.some(message => message.tool_calls?.some(call => call.id === 'unfinished')));
    return streamed('a missing check.');
  }, { catalogs: { openrouter: [freeCatalogModel('backup')] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Diagnose this bug', settings: fallbackSettings });
    assert.ok(harness.posted.some(message => message.type === 'finish' && /The diagnosis is[\s\S]*a missing check/.test(message.text)));
    assert.ok(!harness.posted.some(message => message.type === 'activity' && message.activity.kind === 'terminal'));
  } finally { harness.restore(); }
});

test('sub-agent failover retains its task and read-only permissions and rejoins the coordinator', async () => {
  let workerFailed = false, coordinatorStarted = false;
  const harness = orchestrationHarness(async body => {
    const specialist = body.messages.some(message => message.content?.includes('You are a read-only specialist sub-agent.'));
    if (specialist) {
      if (!workerFailed) { workerFailed = true; return new Response('Model unavailable', { status: 503 }); }
      assert.ok(['primary', 'backup'].includes(body.model));
      assert.equal(body.tools.length, 5);
      assert.ok(body.messages.some(message => message.role === 'user' && message.content.includes('Request: Refactor the entire project')));
      return streamed('Worker recovered and found src/extension.ts.');
    }
    if (!coordinatorStarted) { coordinatorStarted = true; return streamed('I will inspect this task.'); }
    assert.match(body.messages.find(message => message.content?.includes('Sub-agent findings'))?.content || '', /Worker recovered/);
    return streamed('Coordinator completed the task.');
  }, { catalogs: { openrouter: [freeCatalogModel('backup')] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Refactor the entire project', settings: fallbackSettings });
    assert.ok(harness.posted.some(message => message.type === 'activity' && message.activity.title.startsWith('Switch model') && message.activity.parentId));
    assert.ok(harness.posted.some(message => message.type === 'finish' && message.text.includes('Coordinator completed')));
  } finally { harness.restore(); }
});

test('failover attempts are bounded and never choose a paid or unpriced OpenRouter model', async () => {
  const harness = orchestrationHarness(async () => new Response('model unavailable', { status: 503 }), { keys: { 'routerChat.openrouter.apiKey': 'test-key' }, catalogs: { openrouter: [
    ...Array.from({ length: 9 }, (_item, index) => freeCatalogModel('backup-' + index)),
    { id: 'paid', pricing: { prompt: '0.1', completion: '0.1' } }, { id: 'unknown:free' }
  ] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Explain this code', settings: { ...fallbackSettings, mode: 'ask' } });
    assert.equal(harness.requests.length, 5);
    assert.equal(new Set(harness.requests.map(request => request.model)).size, 5);
    assert.ok(harness.requests.every(request => !['paid', 'unknown:free'].includes(request.model)));
    assert.ok(harness.posted.some(message => message.type === 'requestFailed'));
  } finally { harness.restore(); }
});

test('missing fallback credentials and user cancellation stop without retrying unavailable accounts', async () => {
  const harness = orchestrationHarness(async () => new Response('No credits', { status: 402 }), { keys: { 'routerChat.openrouter.apiKey': 'test-key' }, catalogs: { openrouter: [freeCatalogModel('backup')], groq: [{ id: 'unusable-without-key' }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Explain this code', settings: { ...fallbackSettings, mode: 'ask' } });
    assert.equal(harness.requests.length, 1);
    assert.match(harness.posted.findLast(message => message.type === 'error').text, /No alternative available model/);
  } finally { harness.restore(); }
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const cancelled = orchestrationHarness(async (_body, options) => {
    started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('User stopped')), { once: true }));
  }, { catalogs: { openrouter: [freeCatalogModel('backup')] } });
  try {
    await cancelled.receive({ type: 'ready' });
    const sending = cancelled.receive({ type: 'send', text: 'Explain this code', settings: { ...fallbackSettings, mode: 'ask' } });
    await requestStarted;
    await cancelled.receive({ type: 'stop' });
    await sending;
    assert.equal(cancelled.requests.length, 1);
    assert.ok(!cancelled.posted.some(message => message.type === 'modelChanged'));
  } finally { cancelled.restore(); }
});


test('network failures skip replacements that explicitly lack tool support', async () => {
  const harness = orchestrationHarness(async body => {
    if (body.model === 'primary') throw new TypeError('fetch failed');
    assert.equal(body.model, 'b-with-tools');
    return streamed('Recovered after network error.');
  }, { catalogs: { openrouter: [{ ...freeCatalogModel('a-no-tools'), supported_parameters: ['temperature'] }, { ...freeCatalogModel('b-with-tools'), supported_parameters: ['tools', 'temperature'] }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Explain this code', settings: { ...fallbackSettings, mode: 'ask' } });
    assert.deepEqual(harness.requests.map(request => request.model), ['primary', 'b-with-tools']);
    assert.ok(harness.posted.some(message => message.type === 'finish'));
  } finally { harness.restore(); }
});

test('an idle model request times out and continues on the next model', async () => {
  const originalTimeout = global.setTimeout;
  let shortened = false;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 90000 && !shortened) { shortened = true; return originalTimeout(callback, 0, ...args); }
    return originalTimeout(callback, delay, ...args);
  };
  const harness = orchestrationHarness(async (body, options) => {
    if (body.model === 'primary') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Idle request aborted')), { once: true }));
    return streamed('Recovered from timeout.');
  }, { catalogs: { openrouter: [freeCatalogModel('backup')] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Explain this code', settings: { ...fallbackSettings, mode: 'ask' } });
    assert.deepEqual(harness.requests.map(request => request.model), ['primary', 'backup']);
    assert.ok(harness.posted.some(message => message.type === 'activity' && /90 seconds/.test(message.activity.detail)));
    assert.ok(harness.posted.some(message => message.type === 'finish'));
  } finally { harness.restore(); global.setTimeout = originalTimeout; }
});

test('a content-policy error is reported without model switching', async () => {
  const harness = orchestrationHarness(async () => new Response('content policy violation', { status: 400 }), { catalogs: { openrouter: [freeCatalogModel('backup')] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Explain this code', settings: { ...fallbackSettings, mode: 'ask' } });
    assert.equal(harness.requests.length, 1);
    assert.ok(harness.posted.some(message => message.type === 'requestFailed'));
    assert.ok(!harness.posted.some(message => message.type === 'modelChanged'));
  } finally { harness.restore(); }
});


test('provider catalogs filter free Gemini chat models and normalize Mistral capabilities', () => {
  const { normalizeModels, providerId } = require('../out/providers.js');
  const gemini = normalizeModels('gemini', { data: [
    { id: 'gemini-3.8-flash' }, { id: 'models/gemini-2.5-flash', inputTokenLimit: 1048576 },
    { id: 'gemini-4-argon' }, { id: 'gemini-3.1-flash-image' }, { id: 'gemini-embedding-001' },
    { id: 'gemini-3.8-flash' }, { id: 'gemini-2.5-flash-lite', active: false }
  ] });
  assert.deepEqual(gemini.map(model => model.id), ['gemini-2.5-flash', 'gemini-3.8-flash']);
  assert.equal(gemini[0].context_length, 1048576);
  const mistral = normalizeModels('mistral', { data: [
    { id: 'codestral-latest', max_context_length: 32768, capabilities: { completion_chat: true, function_calling: true } },
    { id: 'chat-only', capabilities: { completion_chat: true, function_calling: false } },
    { id: 'mistral-embed', capabilities: { completion_chat: false } }, { id: 'retired', archived: true }
  ] });
  assert.equal(mistral.find(model => model.id === 'codestral-latest').context_length, 32768);
  assert.deepEqual(mistral.find(model => model.id === 'codestral-latest').supported_parameters, ['tools']);
  assert.deepEqual(mistral.find(model => model.id === 'chat-only').supported_parameters, []);
  assert.equal(mistral.length, 2);
  assert.equal(providerId('gemini'), 'gemini');
  assert.equal(providerId('mistral'), 'mistral');
  assert.equal(providerId('invalid'), 'openrouter');
});

test('Gemini and Mistral keys are stored securely and Refresh loads every configured catalog', async () => {
  const harness = orchestrationHarness(async () => streamed('Done'), { keys: {}, catalogs: { gemini: [{ id: 'gemini-3.8-flash' }], mistral: [{ id: 'codestral-latest', capabilities: { completion_chat: true, function_calling: true } }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'refreshModels', settings: { ...fallbackSettings, provider: 'mistral', model: 'codestral-latest', geminiApiKey: 'gemini-secret', mistralApiKey: 'mistral-secret', simpleProvider: 'gemini', simpleModel: 'gemini-3.8-flash', complexProvider: 'mistral', complexModel: 'codestral-latest' } });
    assert.equal(harness.secrets.get('routerChat.gemini.apiKey'), 'gemini-secret');
    assert.equal(harness.secrets.get('routerChat.mistral.apiKey'), 'mistral-secret');
    assert.equal(harness.globals.get('routerChat.settings').simpleProvider, 'gemini');
    assert.equal(harness.globals.get('routerChat.settings').complexProvider, 'mistral');
    assert.ok(!JSON.stringify(harness.globals.get('routerChat.settings')).includes('-secret'));
    assert.deepEqual(harness.catalogRequests.map(request => request.provider).sort(), ['gemini', 'mistral']);
    assert.equal(harness.catalogRequests.find(request => request.provider === 'gemini').url, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
    assert.equal(harness.catalogRequests.find(request => request.provider === 'mistral').options.headers.Authorization, 'Bearer mistral-secret');
    assert.ok(!JSON.stringify(harness.posted).includes('-secret'), 'saved keys never return to the webview');
    await harness.receive({ type: 'ready' });
    assert.equal(harness.posted.findLast(message => message.type === 'settings').settings.provider, 'mistral');
  } finally { harness.restore(); }
});

test('new providers stream tool calls using their own endpoints and compatible history metadata', async t => {
  for (const provider of ['gemini', 'mistral']) await t.test(provider, async () => {
    const model = provider === 'gemini' ? 'gemini-3.8-flash' : 'codestral-latest';
    let turns = 0;
    const harness = orchestrationHarness(async (body, options, url) => {
      turns++;
      assert.equal(options.headers.Authorization, 'Bearer ' + provider + '-secret');
      assert.equal(url, provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' : 'https://api.mistral.ai/v1/chat/completions');
      if (turns === 1) {
        const call = toolCall('read_diagnostics', {}, 'long-call-id-from-previous-model');
        if (provider === 'gemini') call.extra_content = { google: { thought_signature: 'real-provider-signature' } };
        return streamed('', [call]);
      }
      const call = body.messages.find(message => message.tool_calls)?.tool_calls[0];
      assert.ok(call);
      if (provider === 'gemini') assert.equal(call.extra_content.google.thought_signature, 'real-provider-signature');
      else {
        assert.match(call.id, /^[a-z0-9]{9}$/i);
        assert.equal(body.messages.at(-1).tool_call_id, call.id);
        assert.equal(body.messages.filter(message => message.role === 'system').length, 1);
      }
      assert.equal(call.__sourceProvider, undefined);
      assert.equal(call.__sourceModel, undefined);
      return streamed(provider + ' completed the task.');
    }, { keys: { ['routerChat.' + provider + '.apiKey']: provider + '-secret' } });
    try {
      await harness.receive({ type: 'ready' });
      await harness.receive({ type: 'send', text: 'Read diagnostics', settings: { ...fallbackSettings, provider, model } });
      assert.equal(turns, 2);
      assert.ok(harness.posted.some(message => message.type === 'finish' && message.text.startsWith(provider)));
    } finally { harness.restore(); }
  });
});

test('Auto mode discovers models without a manual selection and ignores unconfigured or failed providers', async () => {
  const harness = orchestrationHarness(async (body, options, url) => {
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.match(url, /googleapis/);
    assert.equal(options.headers.Authorization, 'Bearer gemini-secret');
    return streamed('Auto selected a connected provider.');
  }, { keys: { 'routerChat.gemini.apiKey': 'gemini-secret', 'routerChat.mistral.apiKey': 'mistral-secret' }, catalogErrors: { mistral: true }, catalogs: { gemini: [{ id: 'gemini-3.8-flash' }], groq: [{ id: 'unconfigured' }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Explain this function', settings: { ...fallbackSettings, model: '', autoMode: true } });
    assert.equal(harness.requests.length, 1);
    assert.ok(harness.posted.some(message => message.type === 'routing' && message.provider === 'gemini'));
    assert.ok(!harness.catalogRequests.some(request => ['groq', 'openrouter'].includes(request.provider)));
  } finally { harness.restore(); }
});

test('Auto specialists can select different providers from the coordinator', async () => {
  const workerProviders = new Set();
  let parentProvider, coordinatorTurns = 0;
  const harness = orchestrationHarness(async (body, _options, url) => {
    const provider = url.includes('mistral') ? 'mistral' : url.includes('googleapis') ? 'gemini' : url.includes('groq') ? 'groq' : 'openrouter';
    if (body.messages.some(message => message.content?.includes('You are a read-only specialist sub-agent.'))) {
      workerProviders.add(provider);
      assert.equal(body.tools.length, 5);
      return streamed('Independent finding from ' + provider);
    }
    parentProvider = provider;
    if (++coordinatorTurns === 1) return streamed('I will inspect independent parts.');
    assert.match(body.messages.find(message => message.content?.includes('Sub-agent findings'))?.content || '', /Independent finding/);
    return streamed('Coordinated result.');
  }, { catalogs: {
    openrouter: [freeCatalogModel('coder-reasoning:free', 131072)],
    groq: [{ id: 'llama-70b', context_length: 65536 }],
    gemini: [{ id: 'gemini-3.8-flash', context_length: 1048576 }],
    mistral: [{ id: 'codestral-large', max_context_length: 32768, capabilities: { completion_chat: true, function_calling: true } }]
  } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Refactor the entire project architecture', settings: { ...fallbackSettings, model: '', autoMode: true } });
    assert.ok(parentProvider);
    assert.ok(workerProviders.size >= 2, 'workers spread independent tasks across configured providers');
    assert.ok([...workerProviders].some(provider => provider !== parentProvider));
    assert.deepEqual(new Set(harness.catalogRequests.map(request => request.provider)), new Set(['openrouter', 'groq', 'gemini', 'mistral']));
  } finally { harness.restore(); }
});

test('cross-provider handoffs adapt Gemini signatures and Mistral IDs without mutating original tool results', () => {
  const { messagesForProvider } = require('../out/providers.js');
  const working = [
    { role: 'system', content: 'Instructions' },
    { role: 'user', content: 'Task' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'provider-call-with-long-id', type: 'function', function: { name: 'read_diagnostics', arguments: '{}' }, __sourceProvider: 'gemini', __sourceModel: 'gemini-3.8-flash', extra_content: { google: { thought_signature: 'original-signature' } } }] },
    { role: 'tool', tool_call_id: 'provider-call-with-long-id', content: 'Completed results' }
  ];
  const original = structuredClone(working);
  const same = messagesForProvider('gemini', working, 'gemini-3.8-flash');
  assert.equal(same[2].tool_calls[0].extra_content.google.thought_signature, 'original-signature');
  const different = messagesForProvider('gemini', working, 'gemini-2.5-flash');
  assert.equal(different[2].tool_calls[0].extra_content.google.thought_signature, 'skip_thought_signature_validator');
  const mistral = messagesForProvider('mistral', working);
  assert.match(mistral[2].tool_calls[0].id, /^[a-z0-9]{9}$/i);
  assert.equal(mistral[3].tool_call_id, mistral[2].tool_calls[0].id);
  assert.equal(mistral[2].tool_calls[0].extra_content, undefined);
  assert.equal(mistral[3].content, 'Completed results');
  assert.deepEqual(working, original);
});


test('Gemini credit failure continues on Mistral with prior tool context and matching adapted IDs', async () => {
  let geminiTurns = 0;
  const harness = orchestrationHarness(async (body, options, url) => {
    if (url.includes('googleapis')) {
      geminiTurns++;
      if (geminiTurns === 1) {
        const call = toolCall('read_diagnostics', {}, 'gemini-original-long-call-id');
        call.extra_content = { google: { thought_signature: 'gemini-signature' } };
        return streamed('', [call]);
      }
      return new Response('Insufficient credits', { status: 402 });
    }
    assert.equal(url, 'https://api.mistral.ai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer mistral-secret');
    const call = body.messages.find(message => message.tool_calls).tool_calls[0];
    assert.match(call.id, /^[a-z0-9]{9}$/i);
    assert.equal(body.messages.at(-1).tool_call_id, call.id);
    assert.match(body.messages.at(-1).content, /No workspace is open/);
    assert.equal(call.extra_content, undefined);
    return streamed('Continued with the prior findings.');
  }, { keys: { 'routerChat.gemini.apiKey': 'gemini-secret', 'routerChat.mistral.apiKey': 'mistral-secret' }, catalogs: { mistral: [{ id: 'codestral-latest', capabilities: { completion_chat: true, function_calling: true } }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Read diagnostics', settings: { ...fallbackSettings, provider: 'gemini', model: 'gemini-3.8-flash' } });
    assert.deepEqual(harness.requests.map(request => request.model), ['gemini-3.8-flash', 'gemini-3.8-flash', 'codestral-latest']);
    assert.ok(harness.posted.some(message => message.type === 'modelChanged' && message.provider === 'mistral'));
    assert.ok(harness.posted.some(message => message.type === 'finish'));
  } finally { harness.restore(); }
});




test('adaptive provider setup starts only one model for a simple request, including migrated broadcast settings', async () => {
  const harness = orchestrationHarness(async body => {
    assert.equal(body.model, 'a-mini');
    assert.ok(!body.messages.some(message => message.content?.includes('You are a read-only specialist sub-agent.')));
    return streamed('Answered by the first model.');
  }, { catalogs: { openrouter: [freeCatalogModel('a-mini'), freeCatalogModel('b-backup'), freeCatalogModel('c-large')], groq: [{ id: 'groq-chat' }], gemini: [{ id: 'gemini-3.8-flash' }], mistral: [{ id: 'mistral-chat', capabilities: { completion_chat: true, function_calling: true } }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Hello', settings: { mode: 'agent', collaborativeMode: true } });
    assert.equal(harness.requests.length, 1, 'old broadcast settings now use a single coordinator');
    assert.ok(!harness.posted.some(message => message.type === 'activity' && message.activity.kind === 'agent'));
    assert.equal(harness.globals.get('routerChat.settings').adaptiveRouting, true);
    assert.equal(harness.globals.get('routerChat.settings').collaborativeMode, undefined);
  } finally { harness.restore(); }
});

test('adaptive routing switches sequentially only after failure and transfers completed tool context', async () => {
  let primaryTurns = 0, active = 0, peak = 0;
  const harness = orchestrationHarness(async body => {
    active++; peak = Math.max(peak, active);
    try {
      if (body.model === 'a-mini') {
        if (++primaryTurns === 1) return streamed('Checking diagnostics.', [toolCall('read_diagnostics', {}, 'completed-once')]);
        return new Response('Rate limit exceeded', { status: 429 });
      }
      assert.equal(body.model, 'b-backup');
      assert.equal(body.messages.at(-1).tool_call_id, 'completed-once');
      assert.match(body.messages.at(-1).content, /No workspace is open/);
      return streamed('Continued from the previous model.');
    } finally { active--; }
  }, { keys: { 'routerChat.openrouter.apiKey': 'test-key' }, catalogs: { openrouter: [freeCatalogModel('a-mini'), freeCatalogModel('b-backup'), freeCatalogModel('c-backup')] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Hello', settings: { mode: 'agent', adaptiveRouting: true } });
    assert.deepEqual(harness.requests.map(request => request.model), ['a-mini', 'a-mini', 'b-backup']);
    assert.equal(peak, 1);
    assert.ok(!harness.posted.some(message => message.type === 'activity' && message.activity.kind === 'agent'));
    assert.ok(harness.posted.some(message => message.type === 'modelChanged' && message.model === 'b-backup'));
  } finally { harness.restore(); }
});

test('complexity delegation begins after the first coordinator response and shares completed progress', async () => {
  let rootTurns = 0;
  const order = [];
  const harness = orchestrationHarness(async body => {
    const worker = body.messages.some(message => message.content?.includes('You are a read-only specialist sub-agent.'));
    order.push(worker ? 'worker' : 'coordinator');
    if (worker) {
      assert.ok(rootTurns >= 1);
      assert.ok(body.messages.some(message => message.content?.includes('Coordinator progress and completed tool results:') && message.content.includes('No workspace is open')));
      assert.equal(body.tools.length, 5);
      return streamed('Focused specialist findings.');
    }
    if (++rootTurns === 1) return streamed('Starting with diagnostics.', [toolCall('read_diagnostics', {}, 'initial-diagnostics')]);
    assert.match(body.messages.find(message => message.content?.includes('Sub-agent findings'))?.content || '', /Focused specialist findings/);
    assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'initial-diagnostics'));
    return streamed('Completed after complexity-based delegation.');
  }, { catalogs: { openrouter: [freeCatalogModel('coder-large:free', 131072), freeCatalogModel('backup:free')], groq: [{ id: 'groq-small', context_length: 32768 }], gemini: [{ id: 'gemini-3.8-flash', context_length: 1048576 }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Refactor the entire project architecture', settings: { mode: 'agent', adaptiveRouting: true } });
    assert.equal(order[0], 'coordinator');
    assert.equal(order.filter(role => role === 'worker').length, 2, 'only the focused specialists start, not the entire catalog');
    assert.equal(rootTurns, 2);
    assert.equal(harness.requests.length, 4);
    assert.ok(harness.posted.some(message => message.type === 'finish' && message.text.includes('Completed')));
  } finally { harness.restore(); }
});


test('a model chosen from the chat dropdown starts first and still fails over with its context', async () => {
  let selectedCalls = 0;
  const harness = orchestrationHarness(async body => {
    if (body.model === 'manual-model') {
      if (++selectedCalls === 1) return streamed('Inspecting.', [toolCall('read_diagnostics', {}, 'manual-diagnostics')]);
      return new Response('Rate limited', { status: 429 });
    }
    assert.equal(body.model, 'backup-model');
    assert.equal(body.messages.at(-1).tool_call_id, 'manual-diagnostics');
    assert.match(body.messages.at(-1).content, /No workspace is open/);
    return streamed('Continued from the selected model.');
  }, { keys: { 'routerChat.openrouter.apiKey': 'test-key' }, catalogs: { openrouter: [freeCatalogModel('a-mini-auto-favorite'), freeCatalogModel('manual-model'), freeCatalogModel('backup-model')] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Hello', settings: { mode: 'agent', adaptiveRouting: true, simpleModel: 'backup-model', modelOverride: { provider: 'openrouter', model: 'manual-model' } } });
    assert.deepEqual(harness.requests.map(request => request.model).slice(0, 2), ['manual-model', 'manual-model']);
    assert.deepEqual(harness.requests.map(request => request.model), ['manual-model', 'manual-model', 'backup-model']);
    assert.ok(harness.posted.some(message => message.type === 'routing' && message.manual && message.model === 'manual-model'));
    assert.deepEqual(harness.globals.get('routerChat.settings').modelOverride, { provider: 'openrouter', model: 'manual-model' });
  } finally { harness.restore(); }
});

test('a missing or ineligible manual model falls back to automatic selection', async () => {
  const harness = orchestrationHarness(async body => { assert.equal(body.model, 'eligible-mini'); return streamed('Automatic fallback.'); }, { catalogs: { openrouter: [freeCatalogModel('eligible-mini'), { id: 'paid', pricing: { prompt: '1', completion: '1' } }] } });
  try {
    await harness.receive({ type: 'ready' });
    await harness.receive({ type: 'send', text: 'Hello', settings: { mode: 'ask', adaptiveRouting: true, modelOverride: { provider: 'openrouter', model: 'paid' } } });
    assert.equal(harness.requests.length, 1);
    assert.ok(harness.posted.some(message => message.type === 'finish'));
  } finally { harness.restore(); }
});
